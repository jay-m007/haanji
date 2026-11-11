# Haanji

An AI phone receptionist for a small Indian manufacturer, running on your own laptop.

My dad's business, S S Industries in Vasai, makes pins (paper pins, shirt pins, brass pins) under the Suman brand. Most of his day goes on the phone: traders ask the rate, how many boxes, whether it comes in cartons, and then they bargain. In Hindi, Marathi, Gujarati, or all three in one call.

Haanji answers those calls. A language model running locally in [Ollama](https://ollama.com) does the talking. Plain code around it does the things a model should not be trusted with:

- **It can never agree a price.** Every reply is checked before the caller hears it. If the model mentions a rate that is not on the price list, accepts the caller's offer ("चलेगा", "deal", "ચાલશે"), or promises a discount, the reply is replaced with: *"Only Maurya ji decides the final rate. I have noted your offer and he will call you back."* The blocked sentence is kept in the log, so you can see what the model tried to say.
- **Bargaining is recorded, not settled.** The caller's offer goes on the order slip with a red "Owner to confirm" stamp.
- **Quantities are checked against the caller's own words.** If the model writes 15 cartons but the caller said "pachaas peti", the item is flagged. Numbers are understood in digits (also १२ and ૧૨) and in spoken words: *do sau*, *पन्नास*, *પચાસ*, *dedh hazaar*.
- **Units are understood the way traders say them:** peti, कार्टन, डिब्बा, खोका, નંગ, ડઝન, and so on.
- **The price list is a file**, `catalog.json`, with ranges ("₹20 to ₹75 per box depending on size") and items marked "ask the owner".

It can take calls three ways:
- **Phone calls** through an Exotel number: the call audio streams to your computer and Haanji answers by voice.
- **Online calls**: a public "Talk to us now" page (`/call`) where customers press a button and speak. Free, no phone number needed.
- **The simulator** on the desk page, where you play the caller by typing or speaking.

After each call the owner gets a Telegram message with the summary, and every call lands in the calls ledger (summaries, status, CSV export). The speech models are free and run on your own computer ([AI4Bharat](https://huggingface.co/ai4bharat)); Sarvam's paid API can be switched in instead.

## Run it

You need Node 22.18 or newer and Ollama.

```sh
ollama pull gemma3:4b          # or any chat model you like
git clone https://github.com/jay-m007/haanji.git
cd haanji && npm install
npm start
```

Open http://127.0.0.1:5050 in Chrome or Edge (voice input needs one of these). The calls ledger is at http://127.0.0.1:5050/dashboard.

Settings, all optional:

| Variable | Default | |
|---|---|---|
| `HAANJI_MODEL` | `gemma3:4b` | any model you have pulled |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | |
| `HAANJI_PORT` | `5050` | |
| `HAANJI_HOST` | `127.0.0.1` | set `0.0.0.0` to open it to your Wi-Fi; there is no login, so only on a network you trust |
| `HAANJI_CATALOG` | `catalog.json` | |
| `HAANJI_DATA` | `data/calls.json` | |

## Taking real calls

Everything below runs on one Windows laptop with an NVIDIA GPU. The phone line is the only part that costs money.

```
caller ─► dad's mobile ─(busy / no answer: call forwarding)─► Exotel number
      ─► Exotel Voicebot ─(wss, 8 kHz audio)─► Cloudflare tunnel ─► Haanji on the laptop
             Haanji: turn detection ─► speech service (AI4Bharat) ─► Ollama ─► price guard ─► voice back
      after the call ─► Telegram message to dad + calls ledger
```

**1. Speech service (once).** Install Python 3.11, then in a terminal:

```bat
cd haanji\speech
python -m venv .venv
.venv\Scripts\activate
rem PyTorch with CUDA: copy the exact command for your CUDA version from https://pytorch.org/get-started/locally/
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124
pip install -r requirements.txt
```

On huggingface.co, sign in, open [indic-conformer-600m-multilingual](https://huggingface.co/ai4bharat/indic-conformer-600m-multilingual) and accept its terms (it is gated), then run `huggingface-cli login` and paste a read token. Start it with `python server.py`. The first start downloads the models (several GB). It prints whether it is running on `cuda`; on `cpu` it works but is too slow for live calls.

**2. Settings.** Copy `.env.example` to `.env`. Set `HAANJI_PASSWORD` (the dashboard is reachable from the internet once the tunnel runs) and `HAANJI_EXOTEL_TOKEN` (a long random string).

**3. Try it on the laptop.** Run `start-haanji.bat` (or `npm run speech` and `npm start` in two terminals). Open http://127.0.0.1:5050/call, press **Start call** and talk. Use headphones, or the laptop hears its own voice.

**4. Telegram alerts.** In Telegram, message @BotFather, send `/newbot` and put the token in `.env` as `TELEGRAM_BOT_TOKEN`. From your dad's phone, open the new bot and send "hi". Then run `npm run telegram`: it prints the `TELEGRAM_CHAT_ID` line for `.env` and sends a test message.

**5. Public address.** Install [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) and run `cloudflared tunnel --url http://localhost:5050`. It prints an address like `https://something.trycloudflare.com`; put it in `.env` as `HAANJI_PUBLIC_URL` and restart Haanji. The quick address changes every time; for a fixed one, set up a named tunnel with a domain.

**6. Exotel.** Sign up (a 7-day trial needs no KYC; going live needs KYC with business documents). Ask Exotel support to enable the **Voicebot applet** on your account. In App Bazaar, create a flow: **Voicebot** applet with URL `wss://something.trycloudflare.com/exotel/ws?key=YOUR_EXOTEL_TOKEN` (add `&lang=mr` or `&lang=gu` to change the language), then a **Hangup** applet. Attach the flow to your ExoPhone and call that number to test.

**7. Forward dad's missed calls.** On his phone: Settings → Call forwarding → When busy / When unanswered / When unreachable → the ExoPhone number. Start with after-hours only. Check with Exotel that forwarded calls reach the flow on your plan.

Settings for the voice side (all in `.env`):

| Variable | Default | |
|---|---|---|
| `HAANJI_SPEECH` | `local` | `local` (free models), `sarvam` (needs `SARVAM_API_KEY`), `off` |
| `HAANJI_SPEECH_URL` | `http://127.0.0.1:5070` | the speech service (not 5060: browsers and Node refuse that SIP port) |
| `HAANJI_LANG` | `hi` | language when the call does not say |
| `HAANJI_EXOTEL_TOKEN` | | without it, only local test streams are accepted |
| `HAANJI_PASSWORD` | | without it, requests through a tunnel are refused |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | | owner alerts |
| `HAANJI_WEB_CALLS`, `HAANJI_WEB_MAX` | `on`, `2` | the public call page and how many calls at once |

During a call Haanji:
- starts with a disclosure ("this is the automated assistant of S S Industries; the call is written down");
- waits for 0.7 s of silence before answering;
- stops talking when the caller talks over it;
- says "ek second" if the model takes more than 2.5 s;
- ends after 8 minutes (5 for online calls).

If the model is down, it takes the caller's words, promises a call back and hangs up. The lead is still saved and sent.

## The price list

`catalog.json` holds the business details, rules and products. The products and prices in it were copied from the S S Industries IndiaMART page on 11 November 2026, and **they need checking**:

- IndiaMART shows two or three different prices for bell pins, the stainless steel pin and the moti pin, so those are left unpriced. The receptionist says the owner will tell the rate.
- Many items are listed at "₹20/box" with "price range Rs 20 to 75 per box". They are entered as ranges.
- The only carton size on IndiaMART is "master pack of 100 box" for the 16 mm pin. Other items have no carton size yet.
- Office hours are a guess.

Each product can have `price` and optional `max` per unit, `contains` (1 carton = 100 box), a minimum order, aliases in any language, and a `note` for the person editing (never sent to the model).

## How a turn works

```
caller speaks ──► browser speech-to-text ──► POST /api/calls/:id/turn
                                                   │
                     system prompt: price list, rules, what we know, next question
                                                   ▼
                              Ollama /api/chat with a JSON schema
                              → reply, language, intent, lead fields
                                                   │
           merge lead (unknown products and units are dropped, not guessed)
           verify quantities and units against everything the caller said
           guard: unlisted price? agreement while bargaining? discount?
                                                   │
                         safe reply ◄── blocked ──┤── passed ──► reply
                                                   ▼
                       browser reads it aloud; order slip updates
```

The summary for the owner is built from the fields, not written by the model, so it cannot invent anything.

## How good is the model?

I could not test that. My build machine cannot download Ollama or model weights, so every test here runs against a fake Ollama server that returns scripted answers. The tests prove the guards, the number and unit parsing, the maths and the server; they say nothing about how well a real model understands Marathi or Gujarati.

To measure it on your laptop:

```sh
HAANJI_MODEL=gemma3:4b npm run eval
```

This sends the 14 calls in `eval/cases.json` (Hindi, Marathi, Gujarati, mixed and English, including bargaining and unpriced items) and prints, per language, whether the model got the product, quantity, unit and offer right and replied in the right script, how often the guard had to step in, and the time per turn. Results are saved in `eval/results-<model>.json`. Try two or three models and keep the best one.

## Limits

- **The phone path has not taken a real call.** The Exotel connector follows Exotel's published protocol and is tested against a fake Exotel stream, and the online call page was tested in a real browser with a fake microphone and the speech service in fake mode. A real Exotel number, a real voice and the real models have not been in the loop yet.
- **The speech models are untested by me.** My build machine cannot download them or use a GPU. I do not know their accuracy on phone audio or how fast Indic Parler-TTS (0.9B parameters) speaks on your GPU; measure it. If `pip` reports version conflicts between `parler-tts` and the speech-to-text model, put them in two separate environments. Sarvam (`HAANJI_SPEECH=sarvam`) is the fallback.
- **Turn detection is loudness-based.** A loud factory floor or a fan near the phone can cut a sentence short or start one early. The thresholds are in `src/vad.ts`.
- **The simulator's voice depends on the browser.** It uses Chrome's or Edge's own speech service, which sends audio to Google or Microsoft. The phone and online-call paths use the speech service instead.
- I read [hindi-ai-voice-receptionist](https://github.com/nirmallashkari/hindi-ai-voice-receptionist) (MIT; real estate, fixed scripts, Twilio and Exotel) for ideas, and wrote this from scratch with a model instead of scripts.
- **The guard is word lists and number checks.** It catches the common ways of agreeing or quoting, in four languages, and it is tested, but a model can phrase things in ways the lists miss. It errs on the side of blocking: a reply that mentions any amount not on the list is replaced.
- **Small local models are slow on laptops** without a GPU, often several seconds per reply.
- **One password, no user accounts.** Set `HAANJI_PASSWORD` before starting a tunnel; the customer call page stays public by design, limited to 2 calls at once.
- One machine, one JSON file for calls. Fine for tens of calls a day.

## Develop

```sh
npm test          # 80 offline tests: fake Ollama, fake Exotel stream, fake speech
cd speech && python -m unittest test_server.py   # speech service wiring, no models needed
npm run typecheck
```

TypeScript run directly by Node (type stripping), zero runtime dependencies. MIT licensed.
