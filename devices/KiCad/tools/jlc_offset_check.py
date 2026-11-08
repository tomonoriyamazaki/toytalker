#!/usr/bin/env python3
"""JLCPCB（EasyEDA）のフットプリントと KiCad のフットプリントを突き合わせて、
Fabrication Toolkit 用の補正値（FT Position Offset / FT Rotation Offset）を求める。

使い方:
  python devices/KiCad/tools/jlc_offset_check.py devices/KiCad/toytalker_mini_v0.3/toytalker_mini_v0.3.kicad_pcb [REF ...]

- 基板ファイルの各フットプリントの「LCSC Part」項目を読み、EasyEDA の API から
  その部品のフットプリントを取ってパッド座標を比べる（取ったJSONは一時フォルダに保存）。
- 出力の「推奨」が今の値（基板ファイルの FT 項目）と違う部品は、回路図の部品と基板の
  フットプリントの両方に値を入れる（回路図が正本。KiCad なら部品のフィールドに追加）。
- 座標の約束: FT Position Offset は部品ローカル座標で x,y（y は上が正、mm）。
  FT Rotation Offset は度（反時計回りが正）。Fabrication Toolkit の仕様に合わせている。
- 同名パッドの位置で向きを決める。パッド名が JLC 側と違う部品（LED の A/C など）は
  向きを決められないので「名前不一致」と出す。その場合は EasyEDA の記号のピン名で確かめる。
"""
import json, math, os, re, subprocess, sys, tempfile

U = 0.254  # EasyEDA 単位(10mil) → mm

def load_board(path):
    t = open(path, encoding="utf-8").read()
    out = {}
    for m in re.finditer(r'\n\t\(footprint "([^"]+)"', t):
        j = t.find('\n\t(footprint ', m.end())
        blk = t[m.start(): j if j > 0 else None]
        ref = re.search(r'\(property "Reference" "([^"]*)"', blk)
        if not ref:
            continue
        lcsc = re.search(r'\(property "LCSC Part" "([^"]*)"', blk)
        cur_rot = re.search(r'\(property "FT Rotation Offset" "([^"]*)"', blk)
        cur_pos = re.search(r'\(property "FT Position Offset" "([^"]*)"', blk)
        pads = []
        for p in re.finditer(r'\(pad "([^"]*)" (\w+) (\w+)\n\t\t\t\(at ([\d.-]+) ([\d.-]+)(?: ([\d.-]+))?\)\n\t\t\t\(size ([\d.]+) ([\d.]+)\)', blk):
            name, typ, shape, x, y, _rot, w, h = p.groups()
            x, y, w, h = float(x), float(y), float(w), float(h)
            if typ == "np_thru_hole":
                continue
            if shape == "custom":  # カスタムパッドは円プリミティブの中心を使う
                c = re.search(r'\(gr_circle\n\t\t\t\t\t\(center ([\d.-]+) ([\d.-]+)\)', blk[p.end(): p.end() + 3000])
                if c:
                    x, y = x + float(c.group(1)), y + float(c.group(2))
            pads.append((x, -y, name))  # y を上向き正に
        out[ref.group(1)] = dict(fp=m.group(1), lcsc=lcsc.group(1) if lcsc else "", pads=pads,
                                 cur_rot=cur_rot.group(1) if cur_rot else "0",
                                 cur_pos=cur_pos.group(1) if cur_pos else "0,0")
    return out

def easyeda_pads(lcsc, cache):
    f = os.path.join(cache, lcsc + ".json")
    if not os.path.exists(f):
        url = f"https://easyeda.com/api/products/{lcsc}/components?version=6.4.19.5"
        # urllib だと 403 になるので curl（Windows 10 以降に標準で入っている）で取る
        subprocess.run(["curl", "-s", "-L", "-o", f, url], check=True)
    d = json.load(open(f, encoding="utf-8"))["result"]
    ds = d["packageDetail"]["dataStr"]
    ox, oy = float(ds["head"]["x"]), float(ds["head"]["y"])
    pads = []
    for s in ds["shape"]:
        p = s.split("~")
        if p[0] != "PAD" or p[6] not in ("1", "11"):
            continue
        pads.append(((float(p[2]) - ox) * U, -(float(p[3]) - oy) * U, p[8], float(p[4]) * U, float(p[5]) * U))
    # 細い多角形に分割されたパッド（GND リングなど）は同名をまとめる
    if any(w < 0.1 or h < 0.1 for _, _, _, w, h in pads):
        g = {}
        for x, y, n, _, _ in pads:
            g.setdefault(n, []).append((x, y))
        pads = [(sum(a[0] for a in l) / len(l), sum(a[1] for a in l) / len(l), n, 0, 0) for n, l in g.items()]
    return d["packageDetail"].get("title", ""), [(x, y, n) for x, y, n, _, _ in pads]

def rot(p, th):
    c, s = math.cos(math.radians(th)), math.sin(math.radians(th))
    return (p[0] * c - p[1] * s, p[0] * s + p[1] * c)

def fit(K, E):
    kc = (sum(p[0] for p in K) / len(K), sum(p[1] for p in K) / len(K))
    kn = {n: (x, y) for x, y, n in K}
    best = None
    for th in (0, 90, 180, 270):
        Er = [rot((x, y), th) + (n,) for x, y, n in E]
        ec = (sum(p[0] for p in Er) / len(Er), sum(p[1] for p in Er) / len(Er))
        T = (kc[0] - ec[0], kc[1] - ec[1])
        Et = [(x + T[0], y + T[1], n) for x, y, n in Er]
        geo = sum(min(math.hypot(a[0] - b[0], a[1] - b[1]) for b in K) for a in Et) / len(Et)
        same = [math.hypot(x - kn[n][0], y - kn[n][1]) for x, y, n in Et if n in kn]
        name = sum(same) / len(same) if same else None
        cand = (round(geo, 2), name if name is not None else 9, abs(((th + 180) % 360) - 180), th, T, geo, name)
        if best is None or cand < best:
            best = cand
    return best

def main():
    sys.stdout.reconfigure(encoding="utf-8")
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(1)
    board = load_board(sys.argv[1])
    refs = sys.argv[2:] or sorted(board)
    cache = os.path.join(tempfile.gettempdir(), "jlc_offset_check")
    os.makedirs(cache, exist_ok=True)
    seen = set()
    for ref in refs:
        v = board[ref]
        if not v["lcsc"] or not v["pads"]:
            print(f"{ref:5} LCSC 無しかパッド無し。スキップ"); continue
        key = (v["lcsc"], v["fp"])
        if key in seen:
            continue
        seen.add(key)
        title, E = easyeda_pads(v["lcsc"], cache)
        _, _, _, th, T, geo, name = fit(v["pads"], E)
        tx, ty = (0.0 if abs(T[0]) < 0.02 else round(T[0], 3)), (0.0 if abs(T[1]) < 0.02 else round(T[1], 3))
        pos = f"{tx:g},{ty:g}"
        flag = ""
        cur = (v["cur_rot"], v["cur_pos"])
        try:
            cx, cy = (float(s) for s in cur[1].split(","))
            same = int(float(cur[0])) % 360 == th and abs(cx - tx) < 0.01 and abs(cy - ty) < 0.01
        except ValueError:
            same = False
        if not same:
            flag = "  <-- 今の値と違う"
        if name is None:
            flag += "  (名前不一致: 向きは EasyEDA の記号で確認)"
        print(f"{ref:5} {v['lcsc']:10} {title[:30]:30} 推奨 回転={th:3} 位置={pos:14} 今={cur[0]:>3} {cur[1]:14} 誤差={geo:.3f}{flag}")

if __name__ == "__main__":
    main()
