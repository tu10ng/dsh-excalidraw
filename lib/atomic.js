/**
 * Atomic file replacement: write a sibling temp file, then rename over the
 * target, so a reader never observes half a JSON document.
 *
 * @module dsh-excalidraw/atomic
 */

import { randomBytes } from 'node:crypto'
import { rename, writeFile } from 'node:fs/promises'

export async function writeFileAtomic(file, text) {
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(temp, text, 'utf8')
  await rename(temp, file)
}
