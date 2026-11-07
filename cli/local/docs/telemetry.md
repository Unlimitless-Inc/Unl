# Telemetry

Unl can send an anonymous ping so the people who make it can tell whether it is any use.
It is off until you turn it on.

## What it sends

It sends four things and nothing else.

- that Unl was installed (once, when you turn this on)
- that you kept a decision, and how many (a number, never the words)
- that Unl spoke first before your agent acted, and how many times
- that Unl was used on a later day (at most once a day)

With each one go the version of Unl and a random id made on this machine. The id is not tied to you, your machine or your project, and you can replace it at any time. It is there for one reason, so that a decision kept a month after installing can be counted.

A ping is one line. This is all of it.

```json
{"v":1,"event":"decision_kept","id":"a-random-id-made-when-you-turn-it-on","unl":"1.0.0","n":3}
```

| Field | What it is |
|---|---|
| `v` | The version of this list. If the list ever changes, the number changes and the ping stops until you have seen the new list and turned it on again. |
| `event` | One of `install`, `decision_kept`, `spoke_first`, `later_day`. |
| `id` | The random id. |
| `unl` | The version of Unl. |
| `n` | How many, for a decision kept or a time Unl spoke first. Left out of the other two. |

## What it never sends

It never sends your decisions, their reasons, your code, file names, folder names,
project names, prompts, your name or your email.

No time or date is sent. The server notes the day a ping arrives.

It goes to Unl's own server and to no analytics company. Your address reaches that server as it does with any request. Unl does not store it. The company that hosts the server keeps its own request log, as every host does.

## Turning it on and off

```bash
npx unlimitless telemetry          # what it sends, and whether it is on
npx unlimitless telemetry on       # turn it on
npx unlimitless telemetry off      # turn it off
npx unlimitless telemetry show     # every ping from this machine, exactly as it went
npx unlimitless telemetry reset    # replace the random id
```

Setting `DO_NOT_TRACK=1` stops it, and so does `UNL_TELEMETRY=0`. It never sends from CI. Nothing in the environment can turn it on.

Every ping is kept in a log on this machine, in `~/.unl/telemetry.log`, so you can read exactly what was sent. A ping that cannot be sent is dropped and is not tried again.

## Why it exists

Download counts say how many people fetched Unl and nothing about whether it helped. The one number that says whether Unl deserves to exist is whether people are still keeping decisions a few weeks after they installed it. That number cannot be read without a ping, so the ping exists, and it is built so that turning it on costs you nothing you would mind.

## What it was modelled on

The rules above follow the most careful examples in open-source tools, each read at its own documentation.

- Off until you turn it on, with a command that also shows the current state, as the Go toolchain does with `go telemetry`.
- The exact thing that is sent shown before you agree, as Syncthing does with its usage report preview.
- A new yes when the list changes, as Syncthing asks again when its report format changes.
- Counts only and no content, as the Go toolchain sends counters.
- A local copy of everything sent, as the Go toolchain keeps.
- A random id you can replace, as Astro does with `astro telemetry reset`.
- `DO_NOT_TRACK` honoured and nothing sent from CI, as Nuxt does.
- Plain words about your address, as Yarn gives.
- The whole of it in the README, as Homebrew and Nuxt do.

The hosted Unl has its own figures for people who sign in to it. They are separate and are never joined to this.
