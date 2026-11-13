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

// ---- コードに書くLLMのモデル名はここだけ（モデルの終了通知が来たら、ここと toytalker-llms の行を見る。ロードマップ15） ----
// 本文の既定は toytalker-llms の is_default 行。これはそのテーブルが読めなかったときの予備
export const FALLBACK_DEFAULT_LLM = { provider: "google", modelId: "gemini-3.5-flash-lite" };
// 相槌（backchannel Lambda 2本）。キャラクターの設定によらず固定。速さ最優先で選ぶ（2026-11-03 計測: 相槌1回 0.5〜0.9秒、2.5 と同じか少し速い）
export const BACKCHANNEL_LLM_MODEL = "gemini-3.5-flash-lite";

// ---- Web検索ツール ----

// say: 検索の間に声で伝える一言。「調べるね」を文章で言わせると、言うだけで検索しない・言って調べずに答える（作り話）が
// 2問目以降で半分近く起きた（素の Gemini 3.5 Flash Lite、2026-11-13）。一言を呼び出しの中に入れると、言った時点で必ず検索が
// 始まっている。say を足すと Gemini は引数の形を崩すことがある（50回中9〜26回）ので、Gemini 側は VALIDATED で呼ぶ（streamGemini）
export const WEB_SEARCH_TOOL = {
  name: "web_search",
  description: "子供の質問に答えるためにウェブ検索する。知識にない最新情報や具体的な事実を調べるときに使う。",
  parameters: {
    type: "object",
    properties: {
      say: { type: "string", description: "検索している間に相手へ声で伝える短い一言。あなたのキャラクターの口調で、毎回違う表現にする（例:「調べてみるね」「ちょっと待ってね」）。15文字以内" },
      query: { type: "string", description: "検索クエリ" },
    },
    required: ["say", "query"],
  },
};

const SAY_MAX_CHARS = 40;
/** web_search の引数を { query, say } に直す。形が崩れていたら、取れるものだけ取る（無ければ null）。
 *  say は文として読めるよう、終わりの句点を補う */
export function searchCallArgs(args) {
  const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const a = args && typeof args === "object" ? args : {};
  const query = str(a.query);
  // 入れ子で届いた say（{ say: { say: "..." } } など）は中の文字列を拾う。検索語と同じ文は一言ではない
  let say = str(a.say);
  if (!say && a.say && typeof a.say === "object") say = str(a.say.say) ?? str(a.say.description);
  if (say && (say.length > SAY_MAX_CHARS || say === query)) say = null;
  if (say && !/[。！？!?…]$/.test(say)) say += "。";
  return { query, say };
}

// 外部の有料APIを呼ぶツールの課金情報。ここに無いツール（デバイス設定変更など）は無料扱いで、
// かかるLLMトークンはLLM側に含まれる。単価は toytalker-api-unit-prices の `${provider}#tool` 行。
export const PAID_TOOLS = {
  web_search: { provider: "brave", model: "web-search" },
};

// 検索結果と一緒に渡す指示。検索直後のターンだけに効かせ、通常ターンの口調には影響させない。
export const TOOL_RESULT_INSTRUCTION = "この検索結果をもとに答えてください。「調べてみるね」「調べてきたよ」「お待たせ」「調べたところ」のような前置き・報告・お礼は入れず、答えの中身から話し始めてください。もう一度検索はできません。口調や温かさはいつも通りのキャラクターのままで、そのあとも自然に会話を続けてください。";

// システムプロンプトに足す検索の案内。検索前の一言はここで頼まず、ツールの say で言わせる（上の WEB_SEARCH_TOOL）
export const SEARCH_TOOL_HINT = "\nウェブ検索ツールが使えます。最新情報や具体的な事実を調べたいときに使ってください。";

/** 「調べてみるね」「ちょっと待ってね、今すぐ調べるね」のような、これから調べると言うだけの1文か。
 *  検索結果を渡した後の返答の1文目にこれが来たら読み上げずに捨てる（検索前にも言っているので2回になる。2026-11-09/10 に ESP32 で確認。ロードマップ30）。
 *  「調べてみたら晴れだったよ」のような結果の文は当たらない（「調べてみた」は対象外） */
// 「これから調べる」の動詞。「お空の様子を見てみるね」「確認してみるね」のような言い方も実機で出た（2026-11-10）
const SEARCH_VERB = "(調べ(てみる|てくる|る)|探し(てみる|てくる)|探す|検索(してみる|してくる|する)|見てみる|確認(してみる|してくる|する))";
const PREFACE_RE = new RegExp(`^[^。！？!?]{0,20}${SEARCH_VERB}(ね|よ|から|わ|のだ)?[^。！？!?]{0,10}[。！？!?…]*$`);
// 「ちょっと待ってね」「少し待っててね」だけの文
const WAIT_RE = /^(ちょっと|少し|すこし|もう)?(だけ)?(待って|まって)(て|てて)?(ね|ください|てね)?[ー〜~]*[。！？!?…]*$/;

export function isSearchPreface(sentence) {
  return PREFACE_RE.test(String(sentence ?? "").trim());
}

/** 返答全体が「探してみるね。待っててね。」のような、調べると言っただけのものか。
 *  ツールを呼ばずにこれで終わったら、本文Lambdaが検索を必ず呼ばせてもう1回頼む（指示ありだと Gemini 3.5 Flash Lite で
 *  ニュースの質問4回中2回これになった。2026-11-10 の比較。ロードマップ30）。長い返答や「調べ」系の動詞が無い返答は当たらない */
export function isSearchPromiseOnly(text) {
  const t = String(text ?? "").trim();
  if (!t || t.length > 60) return false;
  const sentences = t.split(/(?<=[。！？!?])/).map((s) => s.trim()).filter(Boolean);
  if (sentences.length > 3) return false;
  return sentences.some((s) => isSearchPreface(s)) && sentences.every((s) => isSearchPreface(s) || WAIT_RE.test(s));
}

/**
 * 検索結果を返した要求でモデルがまた検索を求めたときの、もう一回分の会話。
 * 最後のツールの往復（呼び出しと結果）を外し、結果を普通の文章として直前の利用者の発話に添える。
 * ツール定義なしで3社とも受け付ける形になる（Anthropic はツールの往復がある会話で tools を外すと拒むため）。
 */
export function inlineLastToolRound(messages) {
  const respIdx = messages.findLastIndex((m) => m.functionResponse);
  if (respIdx < 0) return messages;
  const callIdx = messages.findLastIndex((m, i) => i < respIdx && m.functionCall);
  const r = messages[respIdx].functionResponse.response ?? {};
  const out = messages.filter((_, i) => i !== respIdx && i !== callIdx);
  const userIdx = out.findLastIndex((m) => m.role === "user" && typeof m.content === "string");
  const note = `\n\n（ウェブ検索の結果: ${JSON.stringify(r.results ?? r)}）\n${r.instruction ?? TOOL_RESULT_INSTRUCTION}`;
  if (userIdx < 0) return [...out, { role: "user", content: note.trim() }];
  out[userIdx] = { ...out[userIdx], content: out[userIdx].content + note };
  return out;
}

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
 * @param {"auto"|"none"|"required"} [p.toolChoice]  "none" はツール定義は渡すが呼ばせない（検索結果を返した2回目の要求で使う。
 *   会話に tool の往復が入っていると Anthropic は tools 無しを拒むので、外すのではなく禁止する）。
 *   "required" は必ずどれかのツールを呼ばせる（「探してみるね」と言っただけで終わった返答のやり直しで使う）
 * @param {{in:number,out:number}} p.usage  トークン数の足し込み先
 * @param {object} [p.trace]  backend/shared/trace.mjs の startTrace()。要求ごとの応答コードと所要時間を ext に記録する
 */
export function chatStream({ provider, model, messages, tools = null, toolChoice = "auto", usage, trace = null }) {
  const u = usage ?? { in: 0, out: 0 };
  const choice = tools ? toolChoice : "auto";
  if (provider === "openai")    return streamOpenAI(messages, model, tools, choice, u, trace);
  if (provider === "google")    return streamGemini(messages, model, tools, choice, u, trace);
  if (provider === "anthropic") return streamAnthropic(messages, model, tools, choice, u, trace);
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

function streamOpenAI(messages, model, tools, choice, usage, trace) {
  const body = {
    model,
    temperature: 0.7,
    stream: true,
    stream_options: { include_usage: true },
    messages: toOpenAIMessages(messages),
  };
  if (tools) {
    body.tools = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
    if (choice === "none") body.tool_choice = "none";
    if (choice === "required") body.tool_choice = "required";
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
export function geminiThinkingConfig(model) {
  return /^gemini-2\./.test(model) ? { thinkingBudget: 0 } : { thinkingLevel: "minimal" };
}

function streamGemini(messages, model, tools, choice, usage, trace) {
  const { systemMsg, contents } = toGeminiRequest(messages);
  const body = { contents, generationConfig: { temperature: 0.7, thinkingConfig: geminiThinkingConfig(model) } };
  if (systemMsg) body.systemInstruction = { parts: [{ text: systemMsg.content }] };
  if (tools) body.tools = [{ function_declarations: tools }];
  // 既定（auto）は VALIDATED: 文章で答えるか呼ぶかはモデルが決め、呼ぶときは引数をスキーマどおりにさせる（AUTO だと say が入れ子に
  // なったり検索語が抜けたりした。VALIDATED は100回中0回、速さは同じ。2026-11-13）
  if (tools && choice === "auto") body.toolConfig = { functionCallingConfig: { mode: "VALIDATED" } };
  if (choice === "none") body.toolConfig = { functionCallingConfig: { mode: "NONE" } };
  if (choice === "required") body.toolConfig = { functionCallingConfig: { mode: "ANY" } };
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

function streamAnthropic(messages, model, tools, choice, usage, trace) {
  const { systemMsg, chat } = toAnthropicRequest(messages);
  const body = { model, max_tokens: 1024, stream: true, messages: chat };
  // Claude 4.6 以降は temperature を送ると 400、代わりに effort で思考量を抑える（会話用は low）。
  // Haiku 4.5 など旧世代は逆に effort を受け付けないので temperature のまま
  const legacy = /^claude-(3-|haiku-4-5|sonnet-4-5|opus-4-5)/.test(model);
  if (legacy) body.temperature = 0.7; else body.output_config = { effort: "low" };
  if (systemMsg) body.system = systemMsg.content;
  if (tools) body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  if (choice === "none") body.tool_choice = { type: "none" };
  if (choice === "required") body.tool_choice = { type: "any" };

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
