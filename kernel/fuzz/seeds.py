"""Packs a fuzz corpus directory into one seeds file, or unpacks it.

A seeds file (fuzz/seeds/<target>.seeds) is the minimised corpus as one
file instead of hundreds: each input as a 4-byte little-endian length then
its bytes, in file-name order. tests/fuzz_corpus.rs reads it directly;
fuzz/run.sh unpacks it for libFuzzer.

    python3 fuzz/seeds.py pack <corpus-dir> <seeds-file>
    python3 fuzz/seeds.py unpack <seeds-file> <corpus-dir>
"""
import hashlib
import os
import struct
import sys


def pack(src, dst):
    out = bytearray()
    names = sorted(os.listdir(src))
    for name in names:
        data = open(os.path.join(src, name), "rb").read()
        out += struct.pack("<I", len(data)) + data
    open(dst, "wb").write(out)
    print(f"{len(names)} inputs, {len(out)} bytes -> {dst}")


def unpack(src, dst):
    os.makedirs(dst, exist_ok=True)
    data, at, n = open(src, "rb").read(), 0, 0
    while at < len(data):
        (size,) = struct.unpack_from("<I", data, at)
        item = data[at + 4 : at + 4 + size]
        at += 4 + size
        # Named by content, as libFuzzer names corpus files.
        open(os.path.join(dst, hashlib.sha1(item).hexdigest()), "wb").write(item)
        n += 1
    print(f"{n} inputs -> {dst}")


if __name__ == "__main__":
    {"pack": pack, "unpack": unpack}[sys.argv[1]](sys.argv[2], sys.argv[3])
