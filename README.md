# Haanji

An AI phone receptionist for a small Indian manufacturer, running on your own laptop.

My dad's business, S S Industries in Vasai, makes pins (paper pins, shirt pins, brass pins) under the Suman brand. Most of his day goes on the phone: traders ask the rate, how many boxes, whether it comes in cartons, and then they bargain. In Hindi, Marathi, Gujarati, or all three in one call.

Haanji answers those calls. A language model running locally in [Ollama](https://ollama.com) does the talking. Plain code around it does the things a model should not be trusted with:

- **It can never agree a price.** Every reply is checked before the caller hears it. If the model mentions a rate that is not on the price list, accepts the caller's offer ("चलेगा", "deal", "ચાલશે"), or promises a discount, the reply is replaced with: *"Only Maurya ji decides the final rate. I have noted your offer and he will call you back."* The blocked sentence is kept in the log, so you can see what the model tried to say.
- **Bargaining is recorded, not settled.** The caller's offer goes on the order slip with a red "Owner to confirm" stamp.
- **Quantities are checked against the caller's own words.** If the model writes 15 cartons but the caller said "pachaas peti", the item is flagged. Numbers are understood in digits (also १२ and ૧૨) and in spoken words: *do sau*, *पन्नास*, *પચાસ*, *dedh hazaar*.
- **Units are understood the way traders say them:** peti, कार्टन, डिब्बा, खोका, નંગ, ડઝન, and so on.
- **The price list is a file**, `catalog.json`, with ranges ("₹20 to ₹75 per box depending on size") and items marked "ask the owner".

It has a call simulator in the browser (you play the caller, by voice or typing, and it answers aloud) and a calls ledger for the owner with summaries, status and CSV export.

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

- **Not connected to a phone line yet.** It is a browser simulator. A real number needs a telephony provider such as Exotel or Twilio (both paid) plus speech-to-text and text-to-speech on the server side. The [hindi-ai-voice-receptionist](https://github.com/nirmallashkari/hindi-ai-voice-receptionist) project (MIT) shows how that wiring looks; I read it for ideas but wrote this from scratch, with a model instead of fixed scripts.
- **Voice depends on the browser.** Speech input uses Chrome's or Edge's own speech service, which sends audio to Google or Microsoft and needs the internet. Marathi and Gujarati reading voices may not exist on every computer; it falls back to a Hindi voice and says so.
- **The guard is word lists and number checks.** It catches the common ways of agreeing or quoting, in four languages, and it is tested, but a model can phrase things in ways the lists miss. It errs on the side of blocking: a reply that mentions any amount not on the list is replaced.
- **Small local models are slow on laptops** without a GPU, often several seconds per reply.
- **No login.** It listens on 127.0.0.1 by default. Do not expose it to the internet.
- One machine, one JSON file for calls. Fine for tens of calls a day.

## Develop

```sh
npm test          # 54 offline tests, fake Ollama
npm run typecheck
```

TypeScript run directly by Node (type stripping), zero runtime dependencies. MIT licensed.
