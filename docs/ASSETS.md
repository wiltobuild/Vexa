# Asset provenance

- Icons: Lucide (`lucide-react`), ISC license. https://lucide.dev/license
- Fonts: DM Sans and Space Grotesk from Google Fonts, SIL Open Font License. Runtime falls back to system sans-serif if unavailable.
- `apps/web/public/nebula.png`: original AI-generated Vexa artwork created for this project. It is not claimed to be an open-source game screenshot.
- Avatars: CSS-rendered initials. No third-party photos or game logos.
- `favicon.svg`: original simple Vexa lettermark.

Open-source dependency licenses remain with their respective authors.

## Character collection and audio example

The twelve character avatars in `apps/web/src/avatars.tsx` are original vector art created for Vexa (cat, ghost, bot, fox, frog, bear, bunny, owl, squid, bat, imp, panda). They use no external image service. `recall-sample.wav` is an original scripted test phrase synthesized with Windows System.Speech. Demo Whisper uses Xenova/whisper-tiny.en ONNX weights from Hugging Face and Transformers.js; those model/runtime assets load only when requested.
