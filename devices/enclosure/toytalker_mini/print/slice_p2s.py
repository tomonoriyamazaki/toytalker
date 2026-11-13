"""ToyTalker mini 外装を Bambu Lab P2S 向けにスライスして、設定入りのプレート 3MF を作る。

使い方（このフォルダで）:
    python slice_p2s.py v0.6
    python slice_p2s.py v0.7 --filament "Bambu PLA Matte @BBL P2S" --infill 20%
    python slice_p2s.py v0.6.3_sw02 v0.6.3_sw02_thin --name v0.6.3_sw02_both   （複数の版を 1 枚のプレートに並べる）

入力:  toytalker_mini_<版>_box.stl / _lid.stl（Fusion の exportManager でボディごとに書き出したもの。単位 mm、
       モデル座標のまま = 箱は開口が上、蓋は上面が上）
出力:  toytalker_mini_<版>_plate.3mf（Bambu Studio で開いてそのまま「造形開始」できる）と、
       確認用の plate_1_0.png（等角の見た目）

やること:
  1. Bambu Studio のシステムプリセット（machine / process / filament）を `inherits` をたどって 1 枚に平らにする
     （CLI は inherits を解決しないため。`from` と `compatible_printers` は残さないと弾かれる）
  2. process に外装用の上書きを入れる: 壁 3 周、サポートはプレートからの通常サポートのみ（吊り具の下だけに付く）、
     橋はサポート無し（USB 穴・スイッチ穴の上）、小さな張り出しは無視、インフィル 15%
  3. 蓋の STL を X 軸回りに 180° 回して上面をプレート側にする（爪と突起が上に伸びてサポート不要になる）。
     _knob.stl（スイッチのつまみ）があれば、外面を下に寝かせて一緒に並べる
  4. bambu-studio.exe を CLI で呼び、並べてスライスし、3MF を書き出す。続けて PNG も書き出す
     （--export-png は他の動作と同時に付けられないので 2 回呼ぶ）
"""
import argparse
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile

BS_EXE = r"C:\Program Files\Bambu Studio\bambu-studio.exe"
SYS_DIR = os.path.join(os.environ.get("APPDATA", ""), "BambuStudio", "system", "BBL")

PROCESS_OVERRIDES = {
    "wall_loops": "3",
    "enable_support": "1",
    "support_type": "normal(auto)",
    "support_style": "default",
    "support_threshold_angle": "30",
    "support_on_build_plate_only": "1",
    "bridge_no_support": "1",
    "support_remove_small_overhang": "1",
}


def flatten(kind: str, name: str) -> dict:
    """system/BBL/<kind>/<name>.json を inherits をたどって 1 枚にする。"""
    chain = []
    cur = name
    while cur:
        path = os.path.join(SYS_DIR, kind, cur + ".json")
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        chain.append(d)
        cur = d.get("inherits")
    out = {}
    for d in reversed(chain):
        out.update({k: v for k, v in d.items() if k != "inherits"})
    out["from"] = "system"
    out.setdefault("instantiation", "true")
    return out


def flip_lid(src: str, dst: str, quarter: bool = False) -> None:
    """バイナリ STL を X 軸回りに 180° 回し（y→-y, z→-z）、底が z=0 になるよう持ち上げる。
    quarter=True なら -90°（y→z, z→-y。つまみ用: 外面 +Y を下に寝かせる）。"""
    with open(src, "rb") as f:
        data = f.read()
    cnt = struct.unpack_from("<I", data, 80)[0]
    tris = []
    for i in range(cnt):
        vals = struct.unpack_from("<12f", data, 84 + i * 50)
        rot = (lambda p: (p[0], p[2], -p[1])) if quarter else (lambda p: (p[0], -p[1], -p[2]))
        n = rot(vals[0:3])
        v = [rot(vals[3:6]), rot(vals[6:9]), rot(vals[9:12])]
        tris.append((n, [v[0], v[2], v[1]]))  # 頂点順を入れ替えて面の向きを保つ
    zmin = min(p[2] for _, vs in tris for p in vs)
    out = bytearray(b"\0" * 80) + struct.pack("<I", cnt)
    for n, vs in tris:
        out += struct.pack("<3f", *n)
        for p in vs:
            out += struct.pack("<3f", p[0], p[1], p[2] - zmin)
        out += b"\0\0"
    with open(dst, "wb") as f:
        f.write(out)


def run_cli(args: list, log_path: str) -> int:
    with open(log_path, "a", encoding="utf-8") as log:
        proc = subprocess.run([BS_EXE, *args], stdout=log, stderr=subprocess.STDOUT)
    return proc.returncode


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("version", nargs="+", help="v0.6 のような版。toytalker_mini_<版>_box.stl / _lid.stl を読む。複数書くと 1 枚に並べる")
    ap.add_argument("--name", help="複数の版を並べるときの出力名（toytalker_mini_<name>_plate.3mf）。省くと版を + でつなぐ")
    ap.add_argument("--machine", default="Bambu Lab P2S 0.4 nozzle")
    ap.add_argument("--process", default="0.20mm Standard @BBL P2S")
    ap.add_argument("--filament", default="Bambu PLA Basic @BBL P2S")
    ap.add_argument("--skip-lid", action="store_true", help="蓋を並べない（蓋が前の版と同じで刷り直さないとき）")
    ap.add_argument("--knob-only", type=int, metavar="N", help="つまみ（_knob.stl）だけを版ごとに N 個並べる（小さくて剥がれやすいので予備を刷る）")
    ap.add_argument("--brim", type=float, metavar="MM", help="外周にブリム（1 層のつば）を付ける幅。つまみだけ刷るときは 5 くらい")
    ap.add_argument("--infill", default="15%", help="sparse_infill_density")
    a = ap.parse_args()

    here = os.path.dirname(os.path.abspath(__file__))
    base = f"toytalker_mini_{a.name or '+'.join(a.version)}"
    parts = [(v, os.path.join(here, f"toytalker_mini_{v}_box.stl"), os.path.join(here, f"toytalker_mini_{v}_lid.stl")) for v in a.version]
    for _, box, lid in parts:
        for p in (box, lid):
            if not os.path.exists(p):
                print("見つからない:", p)
                return 1
    if not os.path.exists(BS_EXE):
        print("Bambu Studio が見つからない:", BS_EXE)
        return 1

    work = tempfile.mkdtemp(prefix="toytalker_slice_")
    out_dir = os.path.join(work, "out")
    png_dir = os.path.join(work, "png")
    os.makedirs(out_dir)
    os.makedirs(png_dir)
    log_path = os.path.join(work, "cli.log")

    mach = flatten("machine", a.machine)
    proc = flatten("process", a.process)
    fila = flatten("filament", a.filament)
    proc.update(PROCESS_OVERRIDES)
    proc["sparse_infill_density"] = a.infill
    if a.brim:
        proc["brim_type"] = "outer_only"
        proc["brim_width"] = str(a.brim)
        proc["brim_object_gap"] = "0.1"
    proc["name"] = f"{a.process} - {base}"
    proc["compatible_printers"] = [a.machine]
    fila["compatible_printers"] = [a.machine]
    paths = {}
    for kind, d in (("machine", mach), ("process", proc), ("filament", fila)):
        paths[kind] = os.path.join(work, f"{kind}.json")
        with open(paths[kind], "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False, indent=1)

    models = []
    for v, box, lid in parts:
        tag = v.replace(".", "_")
        if not a.knob_only:
            box_copy = os.path.join(work, f"box_{tag}.stl")
            shutil.copy(box, box_copy)
            models.append(box_copy)
        if not a.skip_lid and not a.knob_only:
            lid_flipped = os.path.join(work, f"lid_{tag}.stl")
            flip_lid(lid, lid_flipped)
            models.append(lid_flipped)
        knob = os.path.join(here, f"toytalker_mini_{v}_knob.stl")
        if os.path.exists(knob):
            knob_flat = os.path.join(work, f"knob_{tag}.stl")
            flip_lid(knob, knob_flat, quarter=True)
            models.append(knob_flat)
            for n in range(1, a.knob_only or 1):
                extra = os.path.join(work, f"knob_{tag}_{n}.stl")
                shutil.copy(knob_flat, extra)
                models.append(extra)

    plate_name = f"{base}_plate.3mf"
    rc = run_cli([
        "--debug", "2",
        "--load-settings", f"{paths['machine']};{paths['process']}",
        "--load-filaments", paths["filament"],
        "--arrange", "1", "--orient", "0", "--slice", "0",
        "--export-3mf", plate_name, "--outputdir", out_dir,
        *models,
    ], log_path)
    result_path = os.path.join(out_dir, "result.json")
    result = json.load(open(result_path, encoding="utf-8")) if os.path.exists(result_path) else {}
    if rc != 0 or not os.path.exists(os.path.join(out_dir, plate_name)):
        print("スライス失敗 rc=", rc, result.get("error_string"), "\nログ:", log_path)
        return 1

    plate_src = os.path.join(out_dir, plate_name)
    run_cli(["--debug", "1", "--export-png", "0", "--camera-view", "0", "--outputdir", png_dir, plate_src], log_path)

    shutil.copy(plate_src, os.path.join(here, plate_name))
    png_src = os.path.join(png_dir, "plate_1_0.png")
    if os.path.exists(png_src):
        shutil.copy(png_src, os.path.join(here, f"{base}_plate.png"))

    sp = (result.get("sliced_plates") or [{}])[0]
    fil = (sp.get("filaments") or [{}])[0]
    print("出力:", os.path.join(here, plate_name))
    print("造形時間(秒):", round(sp.get("main_predication", 0)), " フィラメント(g):", round(fil.get("total_used_g", 0), 2))
    print("作業フォルダ（ログ・gcode）:", work)
    return 0


if __name__ == "__main__":
    sys.exit(main())
