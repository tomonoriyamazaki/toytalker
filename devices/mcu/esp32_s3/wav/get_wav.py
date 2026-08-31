# save_wav_from_serial.py
import serial, re, os

PORT = "COM3"          # あなたのポート名に変更
BAUD = 115200
OUT  = r"C:\Users\exodj\projects\toytalker\devices\mcu\esp32_s3\wav\record.wav"

os.makedirs(os.path.dirname(OUT), exist_ok=True)

with serial.Serial(PORT, BAUD, timeout=60) as ser:
    print("Waiting for WAVSIZE...")
    size = None
    while True:
        line = ser.readline().decode(errors="ignore").strip()
        if not line:
            continue
        print(line)
        m = re.match(r"WAVSIZE:(\d+)", line)
        if m:
            size = int(m.group(1))
        if line == "===BEGIN_BIN===":
            break

    if size is None:
        raise RuntimeError("WAVSIZE not received")

    print(f"Reading {size} bytes...")
    data = bytearray()
    while len(data) < size:
        chunk = ser.read(min(4096, size - len(data)))
        if not chunk:
            raise RuntimeError("Serial timed out before receiving full file")
        data += chunk

    # ENDマーカー行を読み捨てる（任意）
    _ = ser.readline()

    with open(OUT, "wb") as f:
        f.write(data)
    print(f"✅ Saved: {OUT} ({len(data)} bytes)")
