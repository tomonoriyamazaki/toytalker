// LLM呼び出しとWeb検索ツールの共通部。本文Lambda（App用・ESP32用）が使う。
//
// 会話は会社に依らない1つの形で持ち、各社向けの変換はこのファイルに閉じ込める:
//   { role: "system" | "user" | "assistant", content: string }
//   { role: "assistant", functionCall: { id, name, args, signature } } … LLMがツールを呼んだ（toolRoundMessages が作る）
//   { role: "user", functionResponse: { id, name, response } }          … ツールの結果を返す（同上）
//
// chatStream() は次のイベントを順に返す:
//   { type: "text", text }                             … 返答の断片
//   { type: "toolCall", id, name, args, signature }    … ツール呼び出し（この後ストリームは終わる）
// トークン数は呼び出し側が渡す usage = { in, out } に足し込む（検索ありのターンは要求が2回になる）。
import { secret } from "./secrets.mjs";

// ---- Web検索ツール ----

export const WEB_SEARCH_TOOL = {
  name: "web_search",
  description: "子供の質問に答えるためにウェブ検索する。知識にない最新情報や具体的な事実を調べるときに使う。",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "検索クエリ" } },
    required: ["query"],
  },
};

// 外部の有料APIを呼ぶツールの課金情報。ここに無いツール（デバイス設定変更など）は無料扱いで、
// かかるLLMトークンはLLM側に含まれる。単価は toytalker-api-unit-prices の `${provider}#tool` 行。
export const PAID_TOOLS = {
  web_search: { provider: "brave", model: "web-search" },
};

// 検索結果と一緒に渡す指示。検索直後のターンだけに効かせ、通常ターンの口調には影響させない。
export const TOOL_RESULT_INSTRUCTION = "この検索結果をもとに答えてください。「調べてきたよ」「お待たせ」「調べたところ」のような前置き・報告・お礼は入れず、答えの中身から話し始めてください。口調や温かさはいつも通りのキャラクターのままで、そのあとも自然に会話を続けてください。";

/** Brave Search API（自社インデックス、SOC 2、クエリ不共有）。結果は [{ title, snippet, url }]。
 *  2026-10-27に Serper（Google結果の仲介）から切替。子供向け日本語20問で上位3件を比べ同等以上、応答は約半分、
 *  月1,000回まで無料で以後 $5/1,000回。送るのはLLMが作った検索語だけで、識別子や発話そのものは送らない */
export async function searchWeb(query, numResults = 3, trace = null) {
  const key = secret("BRAVE_API_KEY");
  if (!key) throw new Error("BRAVE_API_KEY is not set");
  // 検索語と結果の題名はログに書かない（検索語は発話から作られる。docs/roadmap.md の9）。応答コードと所要時間だけ残す
  const params = new URLSearchParams({ q: query, count: String(numResults), country: "JP", search_lang: "ja", safesearch: "strict" });
  const t = Date.now();
  const resp = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
    headers: { Accept: "application/json", "X-Subscription-Token": key },
  });
  if (!resp.ok) {
    trace?.ext("brave", { status: resp.status, ms: Date.now() - t });
    throw new Error(`Brave API error: ${resp.status}`);
  }
  const data = await resp.json();
  const results = (data.web?.results ?? []).slice(0, numResults).map((item) => ({
    title: item.title ?? "",
    snippet: item.description ?? "",
    url: item.url ?? "",
  }));
  trace?.ext("brave", { status: resp.status, ms: Date.now() - t, results: results.length });
  return results;
}

// ---- 共通の入口 ----

/**
 * @param {object} p
 * @param {"openai"|"google"|"anthropic"} p.provider
 * @param {string} p.model
 * @param {Array} p.messages  上記の共通形
 * @param {Array|null} p.tools  WEB_SEARCH_TOOL のような { name, description, parameters } の配列
 * @param {"auto"|"none"} [p.toolChoice]  "none" はツール定義は渡すが呼ばせない（検索結果を返した2回目の要求で使う。
 *   会話に tool の往復が入っていると Anthropic は tools 無しを拒むので、外すのではなく禁止する）
 * @param {{in:number,out:number}} p.usage  トークン数の足し込み先
 * @param {object} [p.trace]  backend/shared/trace.mjs の startTrace()。要求ごとの応答コードと所要時間を ext に記録する
 */
export function chatStream({ provider, model, messages, tools = null, toolChoice = "auto", usage, trace = null }) {
  const u = usage ?? { in: 0, out: 0 };
  const noTools = tools && toolChoice === "none";
  if (provider === "openai")    return streamOpenAI(messages, model, tools, noTools, u, trace);
  if (provider === "google")    return streamGemini(messages, model, tools, noTools, u, trace);
  if (provider === "anthropic") return streamAnthropic(messages, model, tools, noTools, u, trace);
  return (async function* () { yield { type: "text", text: "（LLM ルート未実装です）" }; })();
}

/** ツール呼び出しとその結果を会話へ足す2件。call は toolCall イベント、response はツールの結果（任意のJSON） */
export function toolRoundMessages(call, response) {
  return [
    { role: "assistant", functionCall: { id: call.id, name: call.name, args: call.args, signature: call.signature } },
    { role: "user", functionResponse: { id: call.id, name: call.name, response } },
  ];
}

let toolCallSeq = 0;
const newToolCallId = () => `call_${Date.now().toString(36)}_${++toolCallSeq}`;

/** SSE（"data: {...}" 行）を1行ずつJSONにして渡す */
async function* readSse(resp) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") return;
      try { yield JSON.parse(data); } catch {}
    }
  }
}

/** POST して応答ヘッダまで待つ。trace には応答コードと、ヘッダが返るまでの時間（ms）を記録する */
async function postJson(url, headers, body, label, trace) {
  const t = Date.now();
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  trace?.ext(label.toLowerCase(), { status: resp.status, ms: Date.now() - t });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`${label} API error: ${resp.status} ${errText}`);
  }
  return resp;
}

// ---- OpenAI（Chat Completions） ----

function toOpenAIMessages(messages) {
  return messages.map((m) => {
    if (m.role === "assistant" && m.functionCall) {
      const c = m.functionCall;
      return { role: "assistant", content: null, tool_calls: [{ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } }] };
    }
    if (m.role === "user" && m.functionResponse) {
      const r = m.functionResponse;
      return { role: "tool", tool_call_id: r.id, content: JSON.stringify(r.response ?? {}) };
    }
    return { role: m.role, content: m.content };
  });
}

function streamOpenAI(messages, model, tools, noTools, usage, trace) {
  const body = {
    model,
    temperature: 0.7,
    stream: true,
    stream_options: { include_usage: true },
    messages: toOpenAIMessages(messages),
  };
  if (tools) {
    body.tools = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
    if (noTools) body.tool_choice = "none";
  }
  return (async function* () {
    const resp = await postJson("https://api.openai.com/v1/chat/completions", { Authorization: `Bearer ${secret("OPENAI_API_KEY")}` }, body, "OpenAI", trace);
    // tool_calls は引数JSONが断片で届くので、終わりまで貯めてから1回だけ返す
    const pending = {};
    let reqIn = 0, reqOut = 0;
    try {
      for await (const chunk of readSse(resp)) {
        if (chunk.usage) {
          reqIn  = chunk.usage.prompt_tokens     ?? reqIn;
          reqOut = chunk.usage.completion_tokens ?? reqOut;
        }
        const choice = chunk.choices?.[0];
        const delta = choice?.delta;
        if (delta?.content) yield { type: "text", text: delta.content };
        for (const tc of delta?.tool_calls ?? []) {
          const slot = (pending[tc.index ?? 0] ??= { id: null, name: "", args: "" });
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name += tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
        }
        if (choice?.finish_reason === "tool_calls") {
          const first = pending[Object.keys(pending)[0]];
          if (first) {
            let args = {};
            try { args = JSON.parse(first.args || "{}"); } catch {}
            yield { type: "toolCall", id: first.id ?? newToolCallId(), name: first.name, args };
            return;
          }
        }
      }
    } finally {
      usage.in  += reqIn;
      usage.out += reqOut;
    }
  })();
}

// ---- Gemini（Generative Language API） ----

function toGeminiRequest(messages) {
  const systemMsg = messages.find((m) => m.role === "system");
  const contents = messages.filter((m) => m.role !== "system").map((m) => {
    if (m.role === "assistant" && m.functionCall) {
      // Gemini 3系は呼び出し時に付く thoughtSignature を返さないと 400 になる
      const part = { functionCall: { name: m.functionCall.name, args: m.functionCall.args } };
      if (m.functionCall.signature) part.thoughtSignature = m.functionCall.signature;
      return { role: "model", parts: [part] };
    }
    if (m.role === "user" && m.functionResponse) {
      return { role: "user", parts: [{ functionResponse: { name: m.functionResponse.name, response: m.functionResponse.response } }] };
    }
    return { role: m.role === "assistant" ? "model" : m.role, parts: [{ text: m.content }] };
  });
  return { systemMsg, contents };
}

// Gemini の思考は切る（会話の遅延と、記録されない思考トークンを避ける）。
// 2.5系は thinkingBudget:0、3系は thinkingLevel:"minimal"（3系に thinkingBudget を送ると 400）
function geminiThinkingConfig(model) {
  return /^gemini-2\./.test(model) ? { thinkingBudget: 0 } : { thinkingLevel: "minimal" };
}

function streamGemini(messages, model, tools, noTools, usage, trace) {
  const { systemMsg, contents } = toGeminiRequest(messages);
  const body = { contents, generationConfig: { temperature: 0.7, thinkingConfig: geminiThinkingConfig(model) } };
  if (systemMsg) body.systemInstruction = { parts: [{ text: systemMsg.content }] };
  if (tools) body.tools = [{ function_declarations: tools }];
  if (noTools) body.toolConfig = { functionCallingConfig: { mode: "NONE" } };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${secret("GOOGLE_API_KEY")}`;

  return (async function* () {
    const resp = await postJson(url, {}, body, "Gemini", trace);
    // usageMetadata は各チャンクに「ここまでの累計」が付く。足し込むと入力がチャンク数倍になるので
    // この要求の最後の値を持ち、終了時に合計へ足す
    let reqIn = 0, reqOut = 0;
    try {
      for await (const parsed of readSse(resp)) {
        if (parsed.usageMetadata) {
          reqIn  = parsed.usageMetadata.promptTokenCount ?? reqIn;
          reqOut = parsed.usageMetadata.candidatesTokenCount ?? reqOut;
        }
        for (const part of parsed.candidates?.[0]?.content?.parts ?? []) {
          if (part.functionCall) {
            yield { type: "toolCall", id: newToolCallId(), name: part.functionCall.name, args: part.functionCall.args ?? {}, signature: part.thoughtSignature };
            return;
          }
          if (part.text && !part.thought) yield { type: "text", text: part.text };
        }
      }
    } finally {
      usage.in  += reqIn;
      usage.out += reqOut;
    }
  })();
}

// ---- Anthropic（Messages API） ----

function toAnthropicRequest(messages) {
  const systemMsg = messages.find((m) => m.role === "system");
  const chat = messages.filter((m) => m.role !== "system").map((m) => {
    if (m.role === "assistant" && m.functionCall) {
      const c = m.functionCall;
      return { role: "assistant", content: [{ type: "tool_use", id: c.id, name: c.name, input: c.args ?? {} }] };
    }
    if (m.role === "user" && m.functionResponse) {
      const r = m.functionResponse;
      return { role: "user", content: [{ type: "tool_result", tool_use_id: r.id, content: JSON.stringify(r.response ?? {}) }] };
    }
    return { role: m.role, content: m.content };
  });
  return { systemMsg, chat };
}

function streamAnthropic(messages, model, tools, noTools, usage, trace) {
  const { systemMsg, chat } = toAnthropicRequest(messages);
  const body = { model, max_tokens: 1024, stream: true, messages: chat };
  // Claude 4.6 以降は temperature を送ると 400、代わりに effort で思考量を抑える（会話用は low）。
  // Haiku 4.5 など旧世代は逆に effort を受け付けないので temperature のまま
  const legacy = /^claude-(3-|haiku-4-5|sonnet-4-5|opus-4-5)/.test(model);
  if (legacy) body.temperature = 0.7; else body.output_config = { effort: "low" };
  if (systemMsg) body.system = systemMsg.content;
  if (tools) body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  if (noTools) body.tool_choice = { type: "none" };

  return (async function* () {
    const resp = await postJson("https://api.anthropic.com/v1/messages", { "x-api-key": secret("ANTHROPIC_API_KEY"), "anthropic-version": "2023-06-01" }, body, "Anthropic", trace);
    let yielded = false;
    let toolUse = null; // { id, name, json } 引数JSONは断片で届く
    for await (const parsed of readSse(resp)) {
      if (parsed.type === "message_start" && parsed.message?.usage) {
        usage.in += parsed.message.usage.input_tokens ?? 0;
      } else if (parsed.type === "content_block_start" && parsed.content_block?.type === "tool_use") {
        toolUse = { id: parsed.content_block.id, name: parsed.content_block.name, json: "" };
      } else if (parsed.type === "content_block_delta") {
        if (parsed.delta?.type === "input_json_delta" && toolUse) {
          toolUse.json += parsed.delta.partial_json ?? "";
        } else if (parsed.delta?.text) {
          yielded = true;
          yield { type: "text", text: parsed.delta.text };
        }
      } else if (parsed.type === "message_delta") {
        if (parsed.usage) usage.out += parsed.usage.output_tokens ?? 0;
        const stop = parsed.delta?.stop_reason;
        if (stop === "tool_use" && toolUse) {
          let args = {};
          try { args = JSON.parse(toolUse.json || "{}"); } catch {}
          yield { type: "toolCall", id: toolUse.id, name: toolUse.name, args };
          return;
        }
        // 安全分類器による拒否（4.6以降）。本文が無いまま終わると無音になるので一言返す
        if (stop === "refusal") {
          console.warn(`[Anthropic] refusal: ${JSON.stringify(parsed.delta?.stop_details ?? null)}`);
          if (!yielded) { yielded = true; yield { type: "text", text: "ごめんね、そのおはなしはできないんだ。ほかのおはなしをしよう！" }; }
        }
      } else if (parsed.type === "message_stop") {
        return;
      }
    }
  })();
}
