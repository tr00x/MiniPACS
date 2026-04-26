#!/usr/bin/env python3
"""
HTJ2K repack helper — Task 0.2 of the HTJ2K pipeline.

Reads an uncompressed DICOM, encodes each frame as HTJ2K (J2C codestream)
using the host's `ojph_compress` binary, and rewrites the file with
encapsulated pixel data carrying transfer syntax 1.2.840.10008.1.2.4.201
(High-Throughput JPEG 2000 with Reversible Filter).

Usage:
    python3 htj2k_repack.py <input.dcm> <output.dcm> [--new-sop-uid]

Options:
    --new-sop-uid   Assign a fresh SOPInstanceUID so the result is treated as
                    a new instance by Orthanc (otherwise it'll dedupe on the
                    original UID and report AlreadyStored).

Requirements:
    - pydicom, numpy on PYTHONPATH
    - ojph_compress on $PATH (brew install openjph, or build OpenJPH)
    - input DICOM should already be uncompressed (Explicit/Implicit VR Little Endian)
"""
from __future__ import annotations

import os
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import pydicom
from pydicom.encaps import encapsulate
from pydicom.uid import UID, generate_uid

HTJ2K_REVERSIBLE_TS = "1.2.840.10008.1.2.4.201"


def _frames(ds: pydicom.Dataset) -> np.ndarray:
    """Return pixel array shaped (NumberOfFrames, Rows, Cols[, Samples])."""
    arr = ds.pixel_array
    nframes = int(getattr(ds, "NumberOfFrames", 1) or 1)
    if nframes == 1 and arr.ndim == 2:
        arr = arr[np.newaxis, ...]
    elif nframes == 1 and arr.ndim == 3 and ds.SamplesPerPixel > 1:
        arr = arr[np.newaxis, ...]
    return arr


def _encode_frame(frame: np.ndarray, *, bits_stored: int, signed: bool, samples: int) -> bytes:
    """Encode a single frame to an HTJ2K J2C codestream using ojph_compress."""
    rows, cols = frame.shape[0], frame.shape[1]

    # ojph_compress wants raw planar data when given a non-image input.
    # We pass the raw bytes through a .raw file (treated as YUV-style raw).
    # 16-bit data must be little-endian unsigned (or signed) integers, packed.
    if bits_stored <= 8:
        dtype = np.int8 if signed else np.uint8
    else:
        dtype = np.int16 if signed else np.uint16

    # Cast to the target dtype (and ensure little-endian byte order)
    if frame.dtype.byteorder == ">" or (frame.dtype.byteorder == "=" and sys.byteorder == "big"):
        frame = frame.astype(dtype).byteswap()
    else:
        frame = frame.astype(dtype, copy=False)

    raw_bytes = frame.tobytes(order="C")

    with tempfile.TemporaryDirectory() as tmpdir:
        in_path = Path(tmpdir) / "frame.raw"
        out_path = Path(tmpdir) / "frame.j2c"
        in_path.write_bytes(raw_bytes)

        # ojph_compress invocation:
        #   raw input requires -dims, -num_comps, -signed, -bit_depth
        #   downsamp {1,1} for monochrome and per-channel for RGB
        downsamp = ",".join(["{1,1}"] * samples)
        cmd = [
            "ojph_compress",
            "-i", str(in_path),
            "-o", str(out_path),
            "-num_comps", str(samples),
            "-signed", ",".join(["true" if signed else "false"] * samples),
            "-bit_depth", ",".join([str(bits_stored)] * samples),
            "-dims", "{%d,%d}" % (cols, rows),
            "-downsamp", downsamp,
            "-reversible", "true",
            "-prog_order", "RPCL",
        ]
        try:
            res = subprocess.run(cmd, capture_output=True, check=True, text=True)
        except subprocess.CalledProcessError as exc:
            print("ojph_compress failed:", " ".join(cmd), file=sys.stderr)
            print("stdout:", exc.stdout, file=sys.stderr)
            print("stderr:", exc.stderr, file=sys.stderr)
            raise
        if res.stderr.strip():
            print(f"  ojph_compress stderr: {res.stderr.strip()}", file=sys.stderr)

        return out_path.read_bytes()


def main(argv: list[str]) -> int:
    args = list(argv[1:])
    new_sop = False
    if "--new-sop-uid" in args:
        new_sop = True
        args.remove("--new-sop-uid")
    if len(args) != 2:
        print(__doc__, file=sys.stderr)
        return 2

    in_path, out_path = args[0], args[1]
    print(f"[htj2k_repack] reading {in_path}")
    ds = pydicom.dcmread(in_path)

    ts = str(ds.file_meta.TransferSyntaxUID)
    print(f"[htj2k_repack] input transfer syntax: {ts}")
    if ts in (HTJ2K_REVERSIBLE_TS,):
        print("[htj2k_repack] input is already HTJ2K — nothing to do", file=sys.stderr)
        return 1

    rows = int(ds.Rows)
    cols = int(ds.Columns)
    bits_stored = int(ds.BitsStored)
    samples = int(getattr(ds, "SamplesPerPixel", 1))
    signed = int(getattr(ds, "PixelRepresentation", 0)) == 1

    frames = _frames(ds)
    nframes = frames.shape[0]
    print(f"[htj2k_repack] {nframes} frame(s), {cols}x{rows}, "
          f"BitsStored={bits_stored}, signed={signed}, samples={samples}")

    encoded: list[bytes] = []
    for i in range(nframes):
        f = frames[i]
        # For multi-sample (RGB), ojph_compress wants component-interleaved
        # planar layout matching DICOM PlanarConfiguration=0 (pixel-interleaved).
        # For MONOCHROME2 (samples==1) f is 2D and we just pass it.
        cs = _encode_frame(f, bits_stored=bits_stored, signed=signed, samples=samples)
        print(f"[htj2k_repack] frame {i+1}/{nframes}: {len(cs)} bytes encoded")
        encoded.append(cs)

    # Re-encapsulate
    ds.PixelData = encapsulate(encoded)
    # Mark as encapsulated (undefined length) and force VR=OB (DICOM PS3.5 §A.4)
    pix = ds["PixelData"]
    pix.is_undefined_length = True
    pix.VR = "OB"

    # Switch transfer syntax
    ds.file_meta.TransferSyntaxUID = UID(HTJ2K_REVERSIBLE_TS)

    # Optionally assign a fresh SOPInstanceUID so Orthanc doesn't dedupe.
    if new_sop:
        new_uid = generate_uid()
        ds.SOPInstanceUID = new_uid
        ds.file_meta.MediaStorageSOPInstanceUID = new_uid
        print(f"[htj2k_repack] assigned new SOPInstanceUID: {new_uid}")

    # Photometric stays the same for HTJ2K reversible (no color transform applied here)
    # Multi-frame fields remain consistent.
    print(f"[htj2k_repack] writing {out_path} (TS={HTJ2K_REVERSIBLE_TS})")
    ds.save_as(out_path, enforce_file_format=True)

    sz_in = os.path.getsize(in_path)
    sz_out = os.path.getsize(out_path)
    print(f"[htj2k_repack] done. input={sz_in} bytes, output={sz_out} bytes "
          f"({sz_out/sz_in*100:.1f}% of original)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
