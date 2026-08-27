"""Blob access from the sidecar.

Must produce byte-identical results to `src/storage/index.ts` — same AES-256-GCM envelope,
same key layout — because the two halves of the app read and write each other's blobs.

Envelope: [1-byte version][12-byte iv][16-byte tag][ciphertext]
"""
from __future__ import annotations

import base64
import os
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

VERSION = 1
IV_LEN = 12
TAG_LEN = 16


class BlobStore:
    def __init__(self) -> None:
        key_b64 = os.environ["STORAGE_ENCRYPTION_KEY"]
        key = base64.b64decode(key_b64)
        if len(key) != 32:
            raise ValueError("STORAGE_ENCRYPTION_KEY must decode to 32 bytes")
        self._aes = AESGCM(key)
        self._driver = os.environ.get("STORAGE_DRIVER", "local")
        self._root = Path(os.environ.get("STORAGE_LOCAL_PATH", "/data/blobs")).resolve()

        if self._driver != "local":
            # The sidecar only ever touches page rasters and source files on the shared
            # volume. If a deployment moves blobs to B2, this needs the same treatment as
            # the TS driver rather than a silent fallback to the local path.
            raise NotImplementedError(
                f"sidecar blob driver '{self._driver}' is not implemented; "
                "see src/storage/b2.ts for the shape it must match"
            )

    def _path(self, key: str) -> Path:
        full = (self._root / key).resolve()
        if full != self._root and self._root not in full.parents:
            raise ValueError(f"blob key escapes storage root: {key}")
        return full

    def seal(self, plaintext: bytes) -> bytes:
        iv = os.urandom(IV_LEN)
        sealed = self._aes.encrypt(iv, plaintext, None)
        body, tag = sealed[:-TAG_LEN], sealed[-TAG_LEN:]
        return bytes([VERSION]) + iv + tag + body

    def open(self, sealed: bytes) -> bytes:
        if sealed[0] != VERSION:
            raise ValueError(f"unknown blob envelope version: {sealed[0]}")
        iv = sealed[1 : 1 + IV_LEN]
        tag = sealed[1 + IV_LEN : 1 + IV_LEN + TAG_LEN]
        body = sealed[1 + IV_LEN + TAG_LEN :]
        return self._aes.decrypt(iv, body + tag, None)

    def get(self, key: str) -> bytes:
        return self.open(self._path(key).read_bytes())

    def put(self, key: str, plaintext: bytes) -> None:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
        tmp.write_bytes(self.seal(plaintext))
        os.replace(tmp, path)

    def delete(self, key: str) -> None:
        self._path(key).unlink(missing_ok=True)
