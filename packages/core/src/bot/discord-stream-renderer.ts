type Segment =
  | { type: 'plain'; content: string }
  | { type: 'code'; content: string }

export function buildAssistantMessageChunks(content: string, maxChars: number) {
  if (!content.trim()) {
    return []
  }

  const segments = collectRenderableSegments(content)
  const chunks: string[] = []
  let currentPlain = ''

  const flushPlain = () => {
    const normalized = currentPlain.trim()
    if (normalized) {
      chunks.push(normalized)
    }
    currentPlain = ''
  }

  for (const segment of segments) {
    if (segment.type === 'plain') {
      let remaining = segment.content

      while (remaining.length > 0) {
        const room = maxChars - currentPlain.length
        if (room <= 0) {
          flushPlain()
          continue
        }

        if (remaining.length <= room) {
          currentPlain += remaining
          break
        }

        const splitAt = findPlainSplitIndex(remaining, room)
        currentPlain += remaining.slice(0, splitAt)
        flushPlain()
        remaining = remaining.slice(splitAt)
      }

      continue
    }

    flushPlain()
    chunks.push(...splitCodeBlock(segment.content, maxChars))
  }

  flushPlain()
  return chunks
}

function collectRenderableSegments(content: string): Segment[] {
  const segments: Segment[] = []
  let cursor = 0

  while (cursor < content.length) {
    const open = content.indexOf('```', cursor)
    if (open === -1) {
      segments.push({ type: 'plain', content: content.slice(cursor) })
      break
    }

    if (open > cursor) {
      segments.push({ type: 'plain', content: content.slice(cursor, open) })
    }

    const close = content.indexOf('```', open + 3)
    if (close === -1) {
      break
    }

    segments.push({ type: 'code', content: content.slice(open, close + 3) })
    cursor = close + 3
  }

  return segments
}

function splitCodeBlock(block: string, maxChars: number) {
  if (block.length <= maxChars) {
    return [block]
  }

  const closeFenceIndex = block.lastIndexOf('```')
  const firstNewlineIndex = block.indexOf('\n', 3)
  const openFenceEnd = firstNewlineIndex !== -1 && firstNewlineIndex < closeFenceIndex
    ? firstNewlineIndex + 1
    : 3

  const openFence = block.slice(0, openFenceEnd)
  const body = block.slice(openFenceEnd, closeFenceIndex)
  const suffix = '\n```'
  const bodyLimit = maxChars - openFence.length - suffix.length

  if (bodyLimit <= 0) {
    return [block.slice(0, maxChars)]
  }

  const chunks: string[] = []
  let remaining = body

  while (remaining.length > 0) {
    const splitAt = findCodeSplitIndex(remaining, bodyLimit)
    const part = remaining.slice(0, splitAt)
    chunks.push(`${openFence}${part.endsWith('\n') ? part.slice(0, -1) : part}${suffix}`)
    remaining = remaining.slice(splitAt)
  }

  return chunks.length > 0 ? chunks : [`${openFence}${suffix}`]
}

function findPlainSplitIndex(content: string, maxChars: number) {
  if (content.length <= maxChars) {
    return content.length
  }

  const window = content.slice(0, maxChars)
  const candidates = [window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf(' ')]
  const splitAt = candidates.find(index => index >= Math.floor(maxChars * 0.6))

  if (splitAt == null || splitAt < 1) {
    return maxChars
  }

  if (window.startsWith('\n\n', splitAt)) {
    return splitAt + 2
  }

  return splitAt + 1
}

function findCodeSplitIndex(content: string, maxChars: number) {
  if (content.length <= maxChars) {
    return content.length
  }

  const newlineIndex = content.lastIndexOf('\n', maxChars)
  return newlineIndex >= Math.floor(maxChars * 0.5)
    ? newlineIndex + 1
    : maxChars
}
