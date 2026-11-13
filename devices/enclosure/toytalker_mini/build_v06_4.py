import adsk.core, adsk.fusion

MM = 0.1  # Fusion API は cm

# v0.6.4。VARIANT を書き換えて Fusion で実行する。v0.6.3 の派生（build_v06_3_variants.py）に、
# v0.2 スイッチを指で動かす「つまみ」（3 つ目のボディ）と、それを抜けなくするレール（箱）・ひさし（蓋）を足した
#   "sw02"      : 基板 v0.2 のスライドスイッチ MSK12C02G15-B 用（穴とくぼみだけ違う）
#   "sw02_thin" : 上に加えて、電池（3）とクッション（1）の分 4 mm 低い薄型。基板は内底に直置き、USB 給電で使う
VARIANT = "sw02"
SW02 = "sw02" in VARIANT
THIN = "thin" in VARIANT

def run(_context: str):
    app = adsk.core.Application.get()
    for d in list(app.documents):
        if d.dataFile is None and not d.isSaved:
            d.close(False)
    doc = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
    des = adsk.fusion.Design.cast(app.activeProduct)
    des.designType = adsk.fusion.DesignTypes.ParametricDesignType
    root = des.rootComponent
    feats = root.features
    V = adsk.core.ValueInput

    # ---------- ユーザーパラメータ（mm） ----------
    P = {}
    def param(name, val, comment):
        p = des.userParameters.add(name, V.createByString(f"{val} mm"), "mm", comment)
        P[name] = val
        return p
    param("board", 40.0, "基板の一辺（v0.3、40×40）")
    param("gap", 0.2, "基板と内壁のすき間（片側）")
    param("wall", 1.3, "側壁と底の厚さ")
    param("inner_h", 5.4 if THIN else 9.4, "内寸の高さ（[電池3＋クッション1＋]基板1＋部品4＋余裕0.4。薄型は電池とクッション無し）")
    param("board_top", 1.0 if THIN else 5.0, "内底から基板上面まで（[電池3＋クッション1＋]基板1）")
    param("lid_t", 1.3, "蓋の厚さ")
    param("corner_r", 1.3, "外形の角の丸み")
    param("hook_len", 2.6, "蓋の爪の長さ（蓋の裏から）")
    param("hook_w", 6.0, "蓋の爪の幅")
    param("hook_t", 1.0, "蓋の爪の厚さ（爪は曲げない。箱の壁をたわませる）")
    param("barb", 0.25, "返しが内壁の面から飛び出す量（= 壁をたわませる量）")
    param("groove_clear", 0.1, "溝の深さの余裕（溝は返しよりこれだけ深い）")
    param("groove_h", 1.2, "溝の高さ")
    param("barb_h", 0.8, "返しの高さ（下は 45° の導入面、上は抜くときの斜面）")
    param("hook_root_r", 0.3, "爪の根元の丸み（層の境目の応力を散らす）")
    param("rim_chamfer", 0.4, "箱の内側の上縁の面取り（蓋の導入と、爪の根元の丸みの逃げ）")
    param("hook_root_r_in", 0.6, "爪の根元の内側の丸み（剥がれ止め。外側は hook_root_r）")
    param("usb_w", 9.6, "USB-C 穴の幅")
    param("usb_h", 3.8, "USB-C 穴の高さ")
    param("sw_slot_l", 3.6 if SW02 else 3.4, "スライドスイッチの穴の長さ（v0.2: ノブ1.3＋動き1.5＋余裕0.8 / v0.3: ノブ1.2＋動き1.4＋余裕）")
    param("sw_slot_h", 1.5 if SW02 else 1.0, "スライドスイッチの穴の高さ（v0.2 は本体 1.4 の中のノブ位置が不確かなので基板上面 0..1.5 を全部開ける）")
    param("btn_nub_d", 3.0, "ボタン突起の直径")
    param("btn_clear", 0.2, "ボタン突起と押し子のすき間（常時）")
    param("btn_tongue_t", 0.6, "ボタン板ばねの厚さ")
    param("spk_hole_d", 1.6, "蓋の音抜き穴の直径")
    param("strap_hole_d", 2.0, "吊り穴の直径")

    board = P["board"]; gap = P["gap"]; wall = P["wall"]; inner_h = P["inner_h"]
    lid_t = P["lid_t"]; cr = P["corner_r"]
    in0 = -gap; in1 = board + gap            # 内壁 -0.2 .. 40.2
    out0 = in0 - wall; out1 = in1 + wall     # 外形 -1.5 .. 41.5
    z_floor = wall                           # 内底
    z_rim = wall + inner_h                   # 箱の上端 = 蓋の裏 (10.7)
    z_lid_top = z_rim + lid_t                # 12.0
    z_board_top = z_floor + P["board_top"]   # 6.3

    # ---------- 道具 ----------
    def plane_at(z):
        inp = root.constructionPlanes.createInput()
        inp.setByOffset(root.xYConstructionPlane, V.createByReal(z * MM))
        pl = root.constructionPlanes.add(inp); pl.isLightBulbOn = False
        return pl
    def sketch_on(z, name):
        sk = root.sketches.add(plane_at(z)); sk.name = name
        return sk
    def rect(sk, x1, y1, x2, y2):
        sk.sketchCurves.sketchLines.addTwoPointRectangle(
            adsk.core.Point3D.create(x1*MM, y1*MM, 0), adsk.core.Point3D.create(x2*MM, y2*MM, 0))
    def circle(sk, cx, cy, d):
        sk.sketchCurves.sketchCircles.addByCenterRadius(adsk.core.Point3D.create(cx*MM, cy*MM, 0), d/2*MM)
    def all_profiles(sk):
        col = adsk.core.ObjectCollection.create()
        for i in range(sk.profiles.count): col.add(sk.profiles.item(i))
        return col
    NEW = adsk.fusion.FeatureOperations.NewBodyFeatureOperation
    JOIN = adsk.fusion.FeatureOperations.JoinFeatureOperation
    CUT = adsk.fusion.FeatureOperations.CutFeatureOperation
    def extrude(profiles, dist_mm, op, participants=None, name=None):
        inp = feats.extrudeFeatures.createInput(profiles, op)
        inp.setDistanceExtent(False, V.createByReal(dist_mm * MM))
        if participants: inp.participantBodies = participants
        f = feats.extrudeFeatures.add(inp)
        if name: f.name = name
        return f
    def edges_where(body, pred):
        col = adsk.core.ObjectCollection.create()
        for e in body.edges:
            if pred(e): col.add(e)
        return col
    def is_vertical_line(e):
        g = e.geometry
        if g.objectType != adsk.core.Line3D.classType(): return False
        d = g.endPoint.copy(); d.x -= g.startPoint.x; d.y -= g.startPoint.y; d.z -= g.startPoint.z
        return abs(d.x) < 1e-6 and abs(d.y) < 1e-6
    def fillet(body, pred, r_mm, name):
        col = edges_where(body, pred)
        if col.count == 0: raise RuntimeError(f"fillet {name}: no edges")
        inp = feats.filletFeatures.createInput()
        inp.addConstantRadiusEdgeSet(col, V.createByReal(r_mm * MM), False)
        f = feats.filletFeatures.add(inp); f.name = name
        return f
    def chamfer(body, pred, d_mm, name):
        col = edges_where(body, pred)
        if col.count == 0: raise RuntimeError(f"chamfer {name}: no edges")
        inp = feats.chamferFeatures.createInput2()
        inp.chamferEdgeSets.addEqualDistanceChamferEdgeSet(col, V.createByReal(d_mm * MM), False)
        f = feats.chamferFeatures.add(inp); f.name = name
        return f
    def near(a, b, tol=0.02): return abs(a - b) < tol * MM
    def edge_bb(e): return e.boundingBox

    # ---------- 箱 ----------
    sk = sketch_on(0, "箱_外形"); rect(sk, out0, out0, out1, out1)
    box = extrude(all_profiles(sk), z_rim, NEW, name="箱_押し出し").bodies.item(0); box.name = "箱"
    # 外側の縦エッジ 4 本だけ（外形の角）
    def outer_vertical(e):
        if not is_vertical_line(e): return False
        bb = edge_bb(e); x = bb.minPoint.x; y = bb.minPoint.y
        return (near(x, out0*MM) or near(x, out1*MM)) and (near(y, out0*MM) or near(y, out1*MM))
    fillet(box, outer_vertical, cr, "箱_角R")
    # シェル（上面を開ける）
    top_face = None
    for f in box.faces:
        if f.geometry.objectType == adsk.core.Plane.classType() and near(f.boundingBox.minPoint.z, z_rim*MM) and near(f.boundingBox.maxPoint.z, z_rim*MM):
            top_face = f
    col = adsk.core.ObjectCollection.create(); col.add(top_face)
    sh = feats.shellFeatures.createInput(col, False); sh.insideThickness = V.createByString("wall")
    feats.shellFeatures.add(sh).name = "箱_シェル"

    # USB-C 穴（左の壁、基板の左縁 x=0 側。基板座標 (1.33, 18.825) → Y = 40-18.825）
    usb_cy = board - 18.825; usb_cz = z_board_top + 3.33/2
    usb_w = P["usb_w"]; usb_h = P["usb_h"]
    skp = root.sketches.add(root.yZConstructionPlane); skp.name = "USB穴"
    # YZ 平面のスケッチ座標: (sketch x, sketch y) = (Y, Z)
    skp.sketchCurves.sketchLines.addTwoPointRectangle(
        adsk.core.Point3D.create(-(usb_cz-usb_h/2)*MM, (usb_cy-usb_w/2)*MM, 0),
        adsk.core.Point3D.create(-(usb_cz+usb_h/2)*MM, (usb_cy+usb_w/2)*MM, 0))
    inp = feats.extrudeFeatures.createInput(all_profiles(skp), CUT)
    inp.setDistanceExtent(False, V.createByReal(out0*MM - 0.05))  # X=0 から -X へ（壁の外まで）
    inp.participantBodies = [box]
    feats.extrudeFeatures.add(inp).name = "USB穴"

    # スライドスイッチ: 奥の壁（基板の上縁 y=0 → Y=40.2..41.5）。ノブ中心 X=5.5、Z は基板上面+0.1..+0.7
    # v0.2 の MSK12C02G15-B: 部品中心 基板 (5.5, 2.85)。ノブは幅 1.3 で X 4.02..6.82 を動き、先端は基板の縁から 1.52 出る（Y 41.52 = 外面とほぼ同じ）
    sw_cx = 5.42 if SW02 else 5.5; sw_cz = z_board_top + (0.75 if SW02 else 0.4)
    rec_w, rec_h, rec_d = (4.5, 1.7, 0.8) if SW02 else (3.0, 1.3, 0.5)   # くぼみの半幅・半高・深さ（v0.2 は先端が底から 0.8 出る）
    sl = P["sw_slot_l"]; shh = P["sw_slot_h"]
    sks = root.sketches.add(root.xZConstructionPlane); sks.name = "スイッチ穴"
    # XZ 平面のスケッチ座標: (sketch x, sketch y) = (X, Z)  ※法線は -Y
    def rect_xz(sk, x1, z1, x2, z2):
        sk.sketchCurves.sketchLines.addTwoPointRectangle(adsk.core.Point3D.create(x1*MM, -z1*MM, 0), adsk.core.Point3D.create(x2*MM, -z2*MM, 0))
    rect_xz(sks, sw_cx-sl/2, sw_cz-shh/2, sw_cx+sl/2, sw_cz+shh/2)
    inp = feats.extrudeFeatures.createInput(all_profiles(sks), CUT)
    inp.setDistanceExtent(False, V.createByReal(out1*MM + 0.05))  # XZ 面(Y=0)から +Y へ（法線 +Y）
    inp.participantBodies = [box]
    feats.extrudeFeatures.add(inp).name = "スイッチ穴"
    # 指のくぼみ（外面から 0.5 掘る: Y 41.0..41.5）
    skr = root.sketches.add(root.xZConstructionPlane); skr.name = "スイッチくぼみ"
    rect_xz(skr, sw_cx-rec_w, sw_cz-rec_h, sw_cx+rec_w, sw_cz+rec_h)
    inp = feats.extrudeFeatures.createInput(all_profiles(skr), CUT)
    inp.startExtent = adsk.fusion.OffsetStartDefinition.create(V.createByReal((out1-rec_d)*MM))
    inp.setDistanceExtent(False, V.createByReal((rec_d+0.1)*MM))
    inp.participantBodies = [box]
    feats.extrudeFeatures.add(inp).name = "スイッチくぼみ"

    # 爪の溝（内壁、Z 8.0..8.8、深さ barb）
    hook_len = P["hook_len"]; hook_w = P["hook_w"]; hook_t = P["hook_t"]; barb = P["barb"]
    z_hook_bot = z_rim - hook_len            # 8.1
    groove_d = barb + P["groove_clear"]; groove_h = P["groove_h"]
    groove_z0 = z_hook_bot - 0.2
    hooks = [  # (壁, 中心座標)。壁の中央寄り（中央が一番たわむ）。右は吊り具（Y 16..24）を避け、左は USB（Y 16.7..25.7）の後ろ
        ("L", 32.0), ("R", 30.0), ("B", 20.0), ("F", 20.0),
    ]
    skg = sketch_on(groove_z0, "爪の溝")
    gw = hook_w + 0.4
    for side, c in hooks:
        if side == "L": rect(skg, in0-groove_d, c-gw/2, in0, c+gw/2)
        if side == "R": rect(skg, in1, c-gw/2, in1+groove_d, c+gw/2)
        if side == "B": rect(skg, c-gw/2, in1, c+gw/2, in1+groove_d)
        if side == "F": rect(skg, c-gw/2, in0-groove_d, c+gw/2, in0)
    extrude(all_profiles(skg), groove_h, CUT, [box], "爪の溝")

    # 蓋を開ける指掛かり（手前の壁の上端の中央、X 16..24、深さ 0.8。中央からこじれば蓋が水平に上がり爪が順に抜ける）
    skn = sketch_on(z_rim - 0.8, "指掛かり"); rect(skn, 16.0, out0-0.05, 24.0, in0+0.05)
    extrude(all_profiles(skn), 0.8 + 0.05, CUT, [box], "指掛かり")
    # 箱の内側の上縁を面取り（指掛かりの所は縁が下がっているので対象外）
    def inner_rim_top(e):
        g = e.geometry
        if g.objectType != adsk.core.Line3D.classType(): return False
        bb = edge_bb(e)
        if not (near(bb.minPoint.z, z_rim*MM) and near(bb.maxPoint.z, z_rim*MM)): return False
        return any(near(bb.minPoint.x, v*MM) and near(bb.maxPoint.x, v*MM) for v in (in0, in1)) or any(near(bb.minPoint.y, v*MM) and near(bb.maxPoint.y, v*MM) for v in (in0, in1))
    chamfer(box, inner_rim_top, P["rim_chamfer"], "箱_内縁面取り")

    if THIN:
        # 薄型は基板が内底に直置き。USB コネクタの脚（基板の裏に出る 4 本: X 1.33 / 5.5、Y 16.85 / 25.5）の逃げを底に 0.6 掘る
        skf = sketch_on(z_floor - 0.6, "USB脚の逃げ")
        for yy in (16.85, 25.5): rect(skf, in0, yy-0.9, 7.0, yy+0.9)
        extrude(all_profiles(skf), 0.65, CUT, [box], "USB脚の逃げ")
        # マイク（基板 (14.1, 18.574) の下向きポート）の真下に音の穴
        skm = sketch_on(0, "マイク穴"); circle(skm, 14.1, board - 18.574, 1.6)
        extrude(all_profiles(skm), wall + 0.05, CUT, [box], "マイク穴")

    # 吊り具（右の壁の外、Y 16..24、Z 4.5..7.5、X 41.5..47.0、穴 Ø2.0 を Y 方向に）
    lug_x1 = out1 + 5.5; lug_z0 = 1.8 if THIN else 4.5; lug_z1 = lug_z0 + 3.0
    skl = sketch_on(lug_z0, "吊り具"); rect(skl, out1-0.2, 16.0, lug_x1, 24.0)
    extrude(all_profiles(skl), lug_z1-lug_z0, JOIN, [box], "吊り具")
    def lug_outer_edges(e):
        g = e.geometry
        if g.objectType != adsk.core.Line3D.classType(): return False
        bb = edge_bb(e)
        along_y = near(bb.minPoint.x, bb.maxPoint.x) and near(bb.minPoint.z, bb.maxPoint.z)
        return along_y and near(bb.minPoint.x, lug_x1*MM) and (near(bb.minPoint.z, lug_z0*MM) or near(bb.minPoint.z, lug_z1*MM))
    fillet(box, lug_outer_edges, 1.4, "吊り具_先端R")
    skh = root.sketches.add(root.xZConstructionPlane); skh.name = "吊り穴"
    skh.sketchCurves.sketchCircles.addByCenterRadius(adsk.core.Point3D.create((out1+3.3)*MM, -(lug_z0+1.5)*MM, 0), P["strap_hole_d"]/2*MM)
    inp = feats.extrudeFeatures.createInput(all_profiles(skh), CUT)
    inp.startExtent = adsk.fusion.OffsetStartDefinition.create(V.createByReal(15.0*MM))
    inp.setDistanceExtent(False, V.createByReal(10.0*MM))
    inp.participantBodies = [box]
    feats.extrudeFeatures.add(inp).name = "吊り穴"

    # ---------- 蓋 ----------
    skd = sketch_on(z_rim, "蓋_外形"); rect(skd, out0, out0, out1, out1)
    lid = extrude(all_profiles(skd), lid_t, NEW, name="蓋_押し出し").bodies.item(0); lid.name = "蓋"
    fillet(lid, outer_vertical, cr, "蓋_角R")
    def lid_top_edges(e):
        bb = edge_bb(e)
        return near(bb.minPoint.z, z_lid_top*MM) and near(bb.maxPoint.z, z_lid_top*MM)
    fillet(lid, lid_top_edges, 0.6, "蓋_上面R")

    # ボタンの板ばね: S2 は基板座標 (17.9, 20.6) → Fusion (17.9, 19.4)。舌 X 12.9..22.9、Y 17.4..29.4、付け根は Y=29.4
    bx, by = 17.9, board - 20.6
    tx0, tx1 = bx-5.0, bx+5.0; ty0, ty1 = by-2.0, by+10.0
    slit = 0.5; tt = P["btn_tongue_t"]
    # 裏から薄くする（付け根の先 1mm まで）
    skt = sketch_on(z_rim, "ボタン_薄肉"); rect(skt, tx0-slit, ty0-slit, tx1+slit, ty1+1.0)
    extrude(all_profiles(skt), lid_t - tt, CUT, [lid], "ボタン_薄肉")
    # U 字のスリット（左・右・手前）
    sku = sketch_on(z_rim, "ボタン_スリット")
    rect(sku, tx0-slit, ty0-slit, tx0, ty1); rect(sku, tx1, ty0-slit, tx1+slit, ty1); rect(sku, tx0, ty0-slit, tx1, ty0)
    extrude(all_profiles(sku), lid_t + 0.05, CUT, [lid], "ボタン_スリット")
    # 突起（舌の裏から押し子の 0.2 上まで）
    nub_bot = z_board_top + 2.5 + P["btn_clear"]
    nub_top = z_rim + (lid_t - tt)
    skb = sketch_on(nub_bot, "ボタン_突起"); circle(skb, bx, by, P["btn_nub_d"])
    extrude(all_profiles(skb), nub_top - nub_bot, JOIN, [lid], "ボタン_突起")

    # 音抜き穴（スピーカー中心 基板 (29.5, 29.5) → Fusion (29.5, 10.5)、3×3、4.5 間隔）
    sx, sy = 29.5, board - 29.5
    sks2 = sketch_on(z_rim, "音抜き穴")
    for i in (-1, 0, 1):
        for j in (-1, 0, 1):
            circle(sks2, sx + 4.5*i, sy + 4.5*j, P["spk_hole_d"])
    extrude(all_profiles(sks2), lid_t + 0.05, CUT, [lid], "音抜き穴")

    # 爪（蓋の裏から下へ）＋ 返し（溝へ）
    # 爪は壁に沿った幅広のスカート（根元を広くして層の境目の剥がれを防ぐ。回り止めも兼ねる）。
    # 範囲は基板の高い部品を避ける: 左は USB コネクタ（Y 16.7..25.7、上面 Z 9.6）と電池プラグ（手前側）、
    # 手前は電池・スピーカーのプラグ（X < 15）とスピーカー（Ø20 まで、X > 26）、右はスピーカー（Y < 16）。隅は 1.5 空ける
    skirts = [  # (壁, 始点, 終点)
        ("L", 27.0, in1-1.5), ("R", 16.0, in1-1.5), ("B", in0+1.5, in1-1.5), ("F", 15.0, 26.0),
    ]
    skk = sketch_on(z_rim, "爪")
    for side, a, b in skirts:
        if side == "L": rect(skk, in0+0.1, a, in0+0.1+hook_t, b)
        if side == "R": rect(skk, in1-0.1-hook_t, a, in1-0.1, b)
        if side == "B": rect(skk, a, in1-0.1-hook_t, b, in1-0.1)
        if side == "F": rect(skk, a, in0+0.1, b, in0+0.1+hook_t)
    extrude(all_profiles(skk), -hook_len, JOIN, [lid], "爪")
    skb2 = sketch_on(z_hook_bot, "爪の返し")
    for side, c in hooks:
        if side == "L": rect(skb2, in0-barb, c-hook_w/2, in0+0.1, c+hook_w/2)
        if side == "R": rect(skb2, in1-0.1, c-hook_w/2, in1+barb, c+hook_w/2)
        if side == "B": rect(skb2, c-hook_w/2, in1-0.1, c+hook_w/2, in1+barb)
        if side == "F": rect(skb2, c-hook_w/2, in0-barb, c+hook_w/2, in0+0.1)
    barb_h = P["barb_h"]
    extrude(all_profiles(skb2), barb_h, JOIN, [lid], "爪の返し")  # 返しの高さ barb_h（Z 8.1..8.9）、溝は 7.9..9.1
    def horiz_edges_at(z, xs, ys):
        def pred(e):
            g = e.geometry
            if g.objectType != adsk.core.Line3D.classType(): return False
            bb = edge_bb(e)
            if not (near(bb.minPoint.z, z*MM) and near(bb.maxPoint.z, z*MM)): return False
            return any(near(bb.minPoint.x, x*MM) and near(bb.maxPoint.x, x*MM) for x in xs) or                    any(near(bb.minPoint.y, y*MM) and near(bb.maxPoint.y, y*MM) for y in ys)
        return pred
    outer_xy = ([in0-barb, in1+barb], [in0-barb, in1+barb])
    # 返しの下外側: 飛び出し（爪面から barb+0.1）全体を 45° の導入面に
    chamfer(lid, horiz_edges_at(z_hook_bot, *outer_xy), barb + 0.1 - 0.02, "爪_導入面取り")
    # 返しの上外側: 抜くときも壁をたわませて抜けるように斜面（横 = 飛び出し全体、縦 = 残りの高さ）
    top_col = edges_where(lid, horiz_edges_at(z_hook_bot + barb_h, *outer_xy))
    if top_col.count == 0: raise RuntimeError("爪_抜き面取り: no edges")
    inp = feats.chamferFeatures.createInput2()
    inp.chamferEdgeSets.addTwoDistancesChamferEdgeSet(top_col, V.createByReal((barb + 0.1 - 0.02) * MM), V.createByReal((barb_h - (barb + 0.1) - 0.02) * MM), False, False)
    feats.chamferFeatures.add(inp).name = "爪_抜き面取り"
    # 爪の根元（蓋の裏との境）に丸み。外側は箱の内縁の面取りが逃げになる
    root_out = [in0+0.1, in1-0.1]; root_in = [in0+0.1+hook_t, in1-0.1-hook_t]
    fillet(lid, horiz_edges_at(z_rim, root_out, root_out), P["hook_root_r"], "爪_根元R_外")
    fillet(lid, horiz_edges_at(z_rim, root_in, root_in), P["hook_root_r_in"], "爪_根元R_内")

    # ---------- スイッチのつまみ（v0.2 スイッチ用。ノブが小さく爪でしか動かせなかった） ----------
    # 奥の壁の外面（Y=out1）に沿って左右に動く板。断面は上下の縁が 45° の「ありつぎ」形で、
    # 下は箱のレール、上は蓋のひさしが同じ角度でかぶさるので、蓋を閉めている間は外れない。
    # 板の裏の舌がくぼみに入り、舌の溝がスイッチのノブをくわえる。印刷は外面を下に寝かせる（張り出しは全部 45°）
    if SW02:
        zb = z_board_top; y0 = out1
        kn_x0, kn_x1 = sw_cx - 5.0, sw_cx + 5.0          # つまみの長さ 10（動き ±0.75）
        rl_x0, rl_x1 = 0.0, 11.6                          # レールとひさしの範囲
        def poly_yz(sk, pts):   # YZ 平面のスケッチ座標は (-Z, Y)
            ls = sk.sketchCurves.sketchLines
            p = [adsk.core.Point3D.create(-z*MM, y*MM, 0) for (y, z) in pts]
            for i in range(len(p)): ls.addByTwoPoints(p[i], p[(i+1) % len(p)])
        def extrude_x(sk, x0, x1, op, bodies, name):
            inp = feats.extrudeFeatures.createInput(all_profiles(sk), op)
            inp.startExtent = adsk.fusion.OffsetStartDefinition.create(V.createByReal(x0*MM))
            inp.setDistanceExtent(False, V.createByReal((x1-x0)*MM))
            if bodies: inp.participantBodies = bodies
            f = feats.extrudeFeatures.add(inp); f.name = name
            return f
        def extrude_y(sk, yy0, yy1, op, bodies, name):
            inp = feats.extrudeFeatures.createInput(all_profiles(sk), op)
            inp.startExtent = adsk.fusion.OffsetStartDefinition.create(V.createByReal(yy0*MM))
            inp.setDistanceExtent(False, V.createByReal((yy1-yy0)*MM))
            if bodies: inp.participantBodies = bodies
            f = feats.extrudeFeatures.add(inp); f.name = name
            return f
        # 箱のレール: 底から立ち上げる（張り出し無し）。上面は板の下端の 0.1 下、先に 45° の爪
        sk1 = root.sketches.add(root.yZConstructionPlane); sk1.name = "つまみレール"
        poly_yz(sk1, [(y0-0.1, 0), (y0+1.5, 0), (y0+1.5, zb-1.05), (y0+0.7, zb-1.85), (y0-0.1, zb-1.85)])
        extrude_x(sk1, rl_x0, rl_x1, JOIN, [box], "つまみレール")
        # 蓋のひさし: 蓋の縁から外へ 1.5 出し、壁の外を下がって板の上端にかぶさる
        sk2 = root.sketches.add(root.yZConstructionPlane); sk2.name = "つまみひさし"
        poly_yz(sk2, [(y0-0.7, z_lid_top), (y0+1.5, z_lid_top), (y0+1.5, zb+2.55), (y0+0.7, zb+3.35), (y0+0.1, zb+3.35), (y0+0.1, z_rim), (y0-0.7, z_rim)])
        extrude_x(sk2, rl_x0, rl_x1, JOIN, [lid], "つまみひさし")
        # つまみ本体（板）
        sk3 = root.sketches.add(root.yZConstructionPlane); sk3.name = "つまみ_板"
        poly_yz(sk3, [(y0+0.1, zb-1.75), (y0+0.6, zb-1.75), (y0+1.5, zb-0.85), (y0+1.5, zb+2.35), (y0+0.6, zb+3.25), (y0+0.1, zb+3.25)])
        knob = extrude_x(sk3, kn_x0, kn_x1, NEW, None, "つまみ_板").bodies.item(0); knob.name = "つまみ"
        # 舌（くぼみの中へ。くぼみの底 Y=out1-rec_d の 0.1 手前まで）とノブの溝（幅 1.6、上下に抜ける）
        sk4 = root.sketches.add(root.xZConstructionPlane); sk4.name = "つまみ_舌"
        rect_xz(sk4, sw_cx-2.25, sw_cz-1.5, sw_cx+2.25, sw_cz+1.5)
        extrude_y(sk4, y0-rec_d+0.1, y0+0.15, JOIN, [knob], "つまみ_舌")
        sk5 = root.sketches.add(root.xZConstructionPlane); sk5.name = "つまみ_ノブ溝"
        rect_xz(sk5, sw_cx-0.8, sw_cz-1.6, sw_cx+0.8, sw_cz+1.6)
        extrude_y(sk5, y0-rec_d, y0+0.35, CUT, [knob], "つまみ_ノブ溝")
        # 指掛かりの溝（外面に縦 3 本、幅 0.8・深さ 0.5）
        sk6 = root.sketches.add(root.xZConstructionPlane); sk6.name = "つまみ_指溝"
        for dx in (-2.6, 0.0, 2.6): rect_xz(sk6, sw_cx+dx-0.4, zb-0.9, sw_cx+dx+0.4, zb+2.4)
        extrude_y(sk6, y0+1.0, y0+1.6, CUT, [knob], "つまみ_指溝")

    # ---------- 報告 ----------
    print("timeline:", des.timeline.count, "params:", des.userParameters.count)
    for b in root.bRepBodies:
        bb = b.boundingBox
        print(f"body {b.name}: ({bb.minPoint.x/MM:.2f},{bb.minPoint.y/MM:.2f},{bb.minPoint.z/MM:.2f})-({bb.maxPoint.x/MM:.2f},{bb.maxPoint.y/MM:.2f},{bb.maxPoint.z/MM:.2f}) vol={b.volume:.3f}cm3 faces={b.faces.count}")
    app.activeViewport.fit()
