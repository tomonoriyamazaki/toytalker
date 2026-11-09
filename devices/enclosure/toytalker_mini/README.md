# ToyTalker mini 外装（enclosure）

ペンダント型 ToyTalker（ESP32-S3 スタンドアロン機、基板 `devices/KiCad/toytalker_mini_v0.3/`）の外装。設計は Autodesk Fusion で行い、ここには書き出した正本を置く。基板は電気の設計、外装は形の設計で版の上がり方が別なので、フォルダも分けている。

## いまの状態（2026-11-09）

- 最新は **v0.6**（Fusion の ToyTalker/mini に 2026-11-09 保存）。Claude Code が Fusion MCP 経由で `build_v06.py` を実行して生成した（v0.5 を手で直したのではなく、新しい文書を一から組んだ。同じスクリプトを Fusion で動かせば同じ形が再現できる）。ここにある `toytalker_mini_v0.6.f3d` / `.step` と `print/` の 3MF・STL は保存直後に書き出したもの。v0.5 は前の版として残す。
- v0.6 の中身: ユーザーパラメータ 20 個（基板 40、すき間 0.2、壁 1.3、内寸高さ 9.4、基板上面 5.0、蓋 1.3、爪 長さ 2.6・幅 6・厚さ 0.8・掛かり 0.4、USB 穴 9.6×3.8、スイッチ穴 3.4×1.0、ボタン突起 Ø3・すき間 0.2・板ばね 0.6、音抜き Ø1.6、吊り穴 Ø2.0）、タイムライン 47 手順、ボディ 2 つ、干渉ゼロ。
  - **箱**: 外寸 43×43×10.7、角 R1.3。左の壁に USB-C 穴、奥の壁にスライドスイッチの穴と外側のくぼみ（6×2.6×深さ 0.5。ノブの先がくぼみの底から 0.3 出る。爪先で動かす）、内壁 4 面に蓋の爪の受け溝、手前の壁の上端に幅 8 の指掛かり、右の壁の外に吊り具（5.5×8×3、Ø2 の穴は壁と平行、先端 R1.4）。
  - **蓋**: 43×43×1.3、上面の縁 R0.6。裏に爪 4 本（返し付き）。中央ボタン S2 の真上に 10×12 の舌を U 字スリット（幅 0.5）で切り、裏から 0.6 厚に薄くした板ばね（1 部品。巻尺の真ん中のボタンの要領）。裏に Ø3 の突起、押し子とのすき間は常時 0.2。スピーカー中心の真上に Ø1.6 の音抜き 3×3。
- 座標の約束（`build_v06.py` と同じ）: Fusion の X = KiCad 基板ローカル x、Y = 40 − KiCad ローカル y、Z は上向きで箱の底が 0。部品位置は `devices/KiCad/toytalker_mini_v0.3/toytalker_mini_v0.3.kicad_pcb` から読んだ（基板原点 12,12）。
- 基板側で決まっている制約: 電池 304040（厚さ 3）＋クッション 1 ＋基板 1 ＋部品 4（`devices/KiCad/toytalker_mini_v0.2/SCHEMATIC_CHECKLIST.md` 13）。電源スイッチ SSAJ110100 のノブは基板上辺から 1.3 出る。ペンダントなので紐の窒息・小部品の誤飲（`docs/certification-checklist.md`）。紐側に引っ張ると外れる留め具を使う前提。
- **印刷して確かめること**（v0.6 の初回。印刷は PLA、Bambu Lab P2S。0.2 のすき間で実用上ちょうど）: (1) 蓋がカチッと止まり、指掛かりから外せるか（硬ければ `barb` 0.3、緩ければ 0.5）、(2) 板ばねボタンの押し心地と耐久（不安なら舌を厚く・長くする）、(3) スイッチがくぼみから爪で動かせるか（無理なら印刷のつまみを足す案に戻す）、(4) USB-C が奥まで刺さるか、(5) マイク SPH0655 は基板の下向きポートで、箱に穴が無い。こもるなら底か壁に小穴を足す。
- 次: 実機（基板 v0.3 到着 11/12 予定）で上の確認 → v0.7。同じ `build_v06.py` と v0.5 を出発点に Codex（GPT-6 Astra）にも同じ指示を出して比べる。

## 印刷の手順（Bambu Studio）

- **スライス済みプロジェクト `print/toytalker_mini_v0.6_plate.3mf`** を Bambu Studio で開けば、下の置き方・設定が入った状態で印刷できる（P2S 0.4 ノズル、Bambu PLA Basic、0.20mm Standard を元に壁 3 周・サポートはプレートからの通常サポートのみ・橋はサポート無し。推定 15 分、8.5 g）。Bambu Studio のコマンドラインで作った: システムのプリセット JSON を `inherits` をたどって 1 枚に平らにし（`from` と `compatible_printers` は残す）、`bambu-studio.exe --load-settings "machine.json;process.json" --load-filaments filament.json --arrange 1 --orient 0 --slice 0 --export-3mf ...` に箱の STL と、Z を反転した蓋の STL を渡す（`--export-png` は他の動作と同時に付けられない）。
- 部品ごとの形は `print/toytalker_mini_v0.6_box.3mf` と `_lid.3mf`（単位 mm。STL も同じ中身）。Fusion から書き出す場合は `exportManager.createC3MFExportOptions(body, path)` でボディごとに出す。
- **箱**: 開口を上にしてそのまま置く。吊り具の下面（高さ 4.5 の張り出し 5.5）だけサポートが要る。他の穴（USB の上の橋 9.6、スイッチ穴、吊り穴 Ø2 横向き、受け溝）はサポート無しで出る。
- **蓋**: 上面を下にして（裏返して）置く。爪と突起が上に伸びるのでサポート不要。ボタンのスリット 0.5 が 1 層目で潰れていたらカッターで通すか、`build_v06.py` の `slit` を 0.6 にして組み直す。
- 層 0.2、壁 3 周以上（爪とスリット脇が中実になる）。インフィルは任意。

## Fusion 側の所在

- データは Autodesk のクラウド（Fusion Team）にあり、PC のフォルダには無い。hub は個人用、プロジェクトは **ToyTalker**（2026-11-09 に作成し、Default Project から 19 件を移した）。中は 3 フォルダ: `mini/`（現行。toytalker_mini_v0.1〜v0.5 と toytalker_speaker_cover_v0.1 / v0.2）、`old_toytalker/`（toytalker_v0.1 / v0.2）、`old_demo/`（toytalk_demo_v2〜v7.1。v7.1 は同名が 3 件）。Default Project に残したのはチュートリアルの 01_Introduction だけ。
- 版は Fusion 内で別名保存（v0.4・v0.5 …）。MCP で探すときは `project="ToyTalker"` を付ける。
- ライセンスは個人用（商用利用不可）。MCP サーバーは個人用でも使えた。

## Claude Code から Fusion を操作する（MCP）

1. Fusion を起動してサインインし、**基本設定 → 一般 → API → 「Fusion MCP サーバ」をオン**（ポート 27182）。使わないときはオフに戻す（ロードマップ 28）。
2. Claude Code 側は 1 回だけ登録（このプロジェクトのローカル設定 `~/.claude.json` に入る。リポジトリには入らない）:
   ```
   claude mcp add --transport http fusion http://127.0.0.1:27182/mcp
   ```
3. 道具は 4 つ: `fusion_mcp_read`（文書の検索・開いている文書・最近の文書、API ドキュメント、スクリーンショット）、`fusion_mcp_execute`（Fusion API の Python スクリプト実行、文書の open / close / save）、`fusion_mcp_update`（undo / redo）、`fusion_mcp_electronics_read`（Fusion Electronics 用。未使用）。**保存は利用者の指示が無い限りしない**作りで、ここでもそれに従う。
4. 書き出しは `Design.exportManager` の `createFusionArchiveExportOptions`（.f3d）と `createSTEPExportOptions`（.step）。スクリプトは `def run(_context: str):` を入口にし、例外は捕まえない（エラー文が返らなくなる）。

## 版の残し方

- Fusion 上の版と同じ名前で `.f3d` と `.step` を置く。古い版はここに残す（基板と同じく、配ったものは消さない）。
- 変更したら上の「いまの状態」を上書きする。日付付きの経過は積み上げない。
