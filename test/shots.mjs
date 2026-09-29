/**
 * Regenerate the three committed panel screenshots.
 *
 * The preview must be pinned and cached-busted: Edge caches `file://` by URL, so
 * each capture goes to a unique name, and headless Edge reports
 * `prefers-color-scheme: dark`, so the theme is always pinned.
 *
 * Run: node test/shots.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const edge = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((candidate) => existsSync(candidate))
if (edge === undefined) throw new Error('Microsoft Edge was not found; install it or capture the shots by hand')

const shots = [
  { name: 'panel-en.png', locale: 'en', theme: 'light' },
  { name: 'panel-zh.png', locale: 'zh', theme: 'light' },
  { name: 'panel-zh-dark.png', locale: 'zh', theme: 'dark' },
]

for (const [index, shot] of shots.entries()) {
  execFileSync(process.execPath, [join(here, 'preview.mjs')], {
    env: { ...process.env, PREVIEW_LOCALE: shot.locale, PREVIEW_THEME: shot.theme },
    stdio: 'inherit',
  })
  const target = join(here, 'shots', shot.name)
  // A fresh URL each time: Edge caches file:// responses by URL.
  const url = `file:///${join(here, 'preview.html').replaceAll('\\', '/')}?shot=${index}`
  execFileSync(edge, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--window-size=820,2200', `--screenshot=${target}`, url], {
    stdio: 'ignore',
  })
  if (!existsSync(target)) throw new Error(`${shot.name} was not written`)
  console.log(`wrote ${target}`)
}
rmSync(join(here, 'preview.html'), { force: true })
