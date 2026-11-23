# Third-party notices

Study Desk copies these libraries into its page (they are not changed, only minified).

## qrcode-generator 2.0.4 (draws the QR code)
Copyright (c) 2009 Kazuhiko Arase. MIT License: https://opensource.org/license/mit
Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.

## jsQR 1.4.0 (reads the QR code from the camera)
Copyright (c) Cosmo Wolfe. Licensed under the Apache License, Version 2.0: https://www.apache.org/licenses/LICENSE-2.0 (full text at that address and in the `jsqr` npm package). The library is used unchanged apart from minification.

## GSAP 3.15.0 (animation)
Copyright (c) GreenSock. Standard "no charge" GreenSock licence: https://gsap.com/standard-license/

## Voice tutor: programs and voices that Study Desk downloads (not included in the installer)
The Windows and Mac program can download these when the user presses Download in the Voice tutor. Each file is pinned and checked with a SHA-256 fingerprint.

- **sherpa-onnx 2.0.2** (the engine, with its `sherpa-onnx-node` wrapper and per-system packages). Copyright (c) the k2-fsa authors. Apache License 2.0: https://github.com/k2-fsa/sherpa-onnx
- **Kokoro** (English voices, `kokoro-int8-multi-lang-v1_0`). Apache License 2.0: https://huggingface.co/hexgrad/Kokoro-82M
- **Supertonic 3** (31-language voices, `sherpa-onnx-supertonic-3-tts-int8`). Code under the MIT licence, voice model under the OpenRAIL-M licence, which allows use but has use restrictions: https://github.com/supertone-inc/supertonic
- **VoiceStudio** is not downloaded or included. If the user already runs it, Study Desk talks to it at `127.0.0.1`. It has its own licence (AGPL-3.0): https://github.com/debpalash/VoiceStudio
