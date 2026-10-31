# cb

Drive a developer-mode Chromebook's Chrome from your Mac (or any machine) over Tailscale:
list and open tabs, take screenshots, record video, monitor frame rate and system load live,
record CPU profiles and performance traces, send clicks and keys, and get a root shell.

It exists to measure web apps, WebGL games and anything else that runs in a browser on the
cheap Chromebooks people actually use, without a cable and without the Chromebook being on the
same network.

```console
$ cb status
host     root@chromebook (DevTools on 127.0.0.1:9333)
chrome   Chrome/133.0.6943.132, ChromeOS 16151.47.0 (dedede)
cpu      Intel(R) Celeron(R) N4500 @ 1.10GHz, 2 cores @ 2800 MHz, load 0.84 1.53 1.66
memory   841 MB available of 3802 MB
battery  54% charging
temps    x86_pkg_temp 39°C, TCPU 34°C
uptime   34m
tabs     1 open

$ cb monitor -d 6
time     fps   p95     slow main  heap   cpu   free    MHz   temp
23:51:31 60.0  16.8ms  0    10%   149MB  17%   1272MB  800   40°C
23:51:32 60.0  16.8ms  0    13%   149MB  19%   1270MB  799   41°C
23:51:33 48.7  33.4ms  2    73%   148MB  47%   1261MB  2800  41°C
23:51:34 59.2  16.7ms  0    10%   148MB  69%   1255MB  800   42°C
23:51:35 60.0  16.8ms  0    7%    148MB  16%   1268MB  800   42°C

summary over 6s
fps          57.7 avg, 30.0 1% low, 48.7 worst interval
frame time   p95 16.8ms  p99 33.3ms
slow frames  2 over 33ms, 1 over 50ms (of 329)
main thread  23% avg, 73% max
JS heap      149MB → 148MB, 149MB max
system cpu   34% avg, 69% max
memory       1255MB available at worst
cpu clock    799-2800 MHz
hottest      42°C

$ cb profile -d 10      # which JS functions cost the most
$ cb record -d 15 -o run.mp4
```

## How it works

```
your machine                                          Chromebook (developer mode)
cb ── ssh master (Tailscale SSH) ───────────────────> tailscaled (userspace, starts at boot)
   └─ 127.0.0.1:9333 ── port forward ───────────────> Chrome --remote-debugging-port=9222 (127.0.0.1 only)
```

- The first `cb` command opens one SSH master connection with a port forward and leaves it
  running; every later command reuses it. `cb tunnel down` closes it.
- Everything else is the [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/)
  over that forward: screenshots and video are `Page.captureScreenshot` / `Page.startScreencast`,
  traces are `Tracing`, input is `Input.dispatch*`.
- Chrome's debugging port only listens on the Chromebook's loopback, so the only way in is
  SSH, which Tailscale SSH authorizes with your tailnet identity.

## Requirements

- A Chromebook in **developer mode** with rootfs verification off (entering developer mode wipes it).
- [Tailscale](https://tailscale.com) on your machine, signed in to the same tailnet.
- [Bun](https://bun.sh) 1.2+ to build, and `ffmpeg` for `cb record` (`brew install ffmpeg`).

## Set up the Chromebook

1. **Developer mode.** Esc + Refresh + Power, then Ctrl+D at the recovery screen. This wipes the device.
2. **Root console.** Press Ctrl+Alt+→ (the forward-arrow key) for the VT2 console and log in as `root`.
   Crosh (Ctrl+Alt+T) won't work here: its shell blocks `sudo`.
3. **Writable system partition**, once:
   ```sh
   /usr/libexec/debugd/helpers/dev_features_rootfs_verification
   reboot
   ```
4. **Run the setup script** from this repo, [`chromebook/setup.sh`](chromebook/setup.sh), as root on VT2.
   Copy it over however you can (USB stick, `curl` from a raw URL), then:
   ```sh
   bash setup.sh --hostname chromebook
   ```
   It turns on Chrome's debugging port, installs Tailscale as a boot service with Tailscale SSH,
   stops the Chromebook sleeping on idle or lid close (`--keep-sleep` to skip), and signs in to
   Tailscale (open the link it prints).
5. `restart ui` if the script says so, so Chrome picks up the debugging flag.

Then, on your machine:

```sh
git clone https://github.com/GrowlyX/cb && cd cb
bun install
bun run install:local   # builds a single binary into ~/.local/bin/cb
cb status
```

The first connection may print a `login.tailscale.com` link: that's Tailscale SSH's "check"
mode asking you to confirm it's you. Open it once and approve.

## Commands

```
Connection:
  status    Check the connection and show Chrome, CPU, memory, battery and temperatures
  tunnel    Show, start or stop the SSH connection cb keeps open
  sh        Run a command on the Chromebook, or open a root shell
  top       Busiest processes on the Chromebook over one second, Chrome processes labeled by type
  gpu       Show the GPU and which graphics features are hardware accelerated (like chrome://gpu)

Tabs:
  tabs      List open tabs (with --all, iframes, workers and extensions too)
  open      Open a URL in a new tab
  nav       Navigate a tab to a URL
  reload    Reload a tab
  focus     Bring a tab to the front
  close     Close a tab
  eval      Run JavaScript in a tab or iframe and print the result
  devtools  Open Chrome's full DevTools for a tab, in a browser on this machine

Capture:
  shot      Screenshot a tab
  record    Record a tab to an MP4 (Ctrl+C stops early)

Performance:
  monitor   Live dashboard of page frame rate and main thread with Chromebook CPU, memory, clock and heat
  fps       Measure frame rate and frame-time percentiles in a tab or iframe
  metrics   Live main-thread load and memory for a tab or iframe, once a second
  profile   Record a JavaScript CPU profile of a tab or iframe and list the slowest functions
  trace     Record a performance trace (open it in DevTools or ui.perfetto.dev) and summarize it
  vitals    Page load timing, Largest Contentful Paint, layout shift and resource totals for a tab

Input:
  click     Click at a point in a tab (CSS pixels from the top left)
  move      Move the mouse to a point in a tab
  scroll    Scroll the mouse wheel at a point
  type      Type text into whatever has focus
  key       Press a key, optionally holding it (e.g. to move in a game)
```

`cb help <command>` shows each command's options.

### Picking a target

`-t` takes the number from `cb tabs`, an id prefix, or any text in the URL or title. With no
`-t`, commands use the first tab. `cb tabs --all` also lists iframes: games often draw in a
cross-site iframe with its own renderer, and that's the frame `cb fps`, `cb metrics` and
`cb eval` should target. Screenshots, video and input always act on the tab, so an iframe
selector there means "the tab this iframe is in".

### Monitoring performance

Start with `cb monitor`, then dig in with the tool it points to.

| Tool | What it answers | Cost on the Chromebook |
|---|---|---|
| `cb monitor` | Is it smooth, and if not, is the page, the CPU, memory or heat to blame? One row per second, then a summary with warnings. `--csv` saves every row. | Low |
| `cb fps` | Frame rate and frame-time percentiles over a fixed window. | Low |
| `cb metrics` | Main-thread busy share, JS heap and DOM size, live. | Low |
| `cb profile` | Which JavaScript functions take the time. Opens in DevTools or speedscope. | Medium |
| `cb trace` | Everything, across every process: tasks, GC, frames, GPU. Opens in DevTools or Perfetto. | High |
| `cb vitals` | How the page loaded: TTFB, FCP, LCP, layout shift, resources. | None |
| `cb top`, `cb gpu` | What else is using the CPU and memory; whether WebGL is hardware accelerated. | None |

`cb monitor` warns about:

- **heap growth** over the session (a leak, or caches still filling)
- **main thread saturation** (CPU bound in the page: run `cb profile`)
- **system CPU saturation** (every core busy: check `cb top`)
- **low available memory** (ChromeOS starts compressing memory and discarding tabs)
- **throttling**: the CPU clock falling well below its peak while the CPU is busy. A slow
  clock while idle is normal power saving and isn't flagged.

### Tips

- **Measure and record separately.** Screencasting costs a low-end CPU real time, so frame rates
  measured during `cb record` are pessimistic.
- **Keep the lid open and the screen on** while measuring. ChromeOS stops painting with the
  screen off, so screenshots time out and frame counters see nothing.
- **Point `-t` at the frame that draws.** A page that renders in a cross-site iframe runs its
  JavaScript in that iframe's renderer; `cb tabs --all` lists them.
- **Memory pressure is common on 4 GB Chromebooks.** The Android container (`crosvm ... ARCVM`)
  alone can hold most of a gigabyte; turning off Google Play frees it.

## Configuration

`~/.config/cb/config.json`, all optional:

```json
{ "host": "chromebook", "user": "root", "remotePort": 9222, "localPort": 9333 }
```

`--host`, `--user` and `--port` override it per command.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `could not reach root@chromebook over SSH` | The Chromebook is offline in `tailscale status`: asleep, or its Wi-Fi dropped. |
| `Chrome's DevTools port is not answering` | `--remote-debugging-port` isn't in `/etc/chrome_dev.conf`, or Chrome hasn't restarted since (`restart ui`). |
| Screenshot times out, `fps` sees no frames | Lid closed or screen off, or the tab is in the background (`cb focus`). |
| `port 9333` is in use | Another `cb` tunnel to a different host. `cb tunnel down` or `--port`. |

## Security

Anyone who can reach Chrome's debugging port controls the browser: every tab, cookie and
signed-in account. `cb` keeps the port on the Chromebook's loopback and on yours, reachable
only through SSH that your Tailscale ACLs authorize. Don't expose port 9222 any other way, and
don't use the developer-mode SSH helper (`dev_features_ssh`): it authorizes a publicly known
root key. The setup script warns if that server is running.

## Development

```sh
bun run check      # lint and format check (Biome), typecheck, tests
bun run format     # apply Biome's formatting and safe fixes
bun src/cli.ts ... # run without building
```

Types live in `src/types.ts`. Commands are in `src/commands/`, one file per group; anything
that can be tested without a Chromebook (parsing, summaries, page scripts) lives in `src/`.

## License

BSD 3-Clause. See [LICENSE](LICENSE).
