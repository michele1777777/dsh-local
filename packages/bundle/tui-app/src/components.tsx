/** @jsxRuntime automatic */
/** Ink owns only painting. Layout and wrapping are independently testable. */
import { memo } from 'react'
import { osc8 } from './links.ts'
import { Box, Text } from 'ink'
import type { Row } from './rich-text.ts'
import { palette, type ThemeName } from './theme.ts'
export function Screen({ rows, width, theme }: { rows: readonly Row[]; width: number; theme: ThemeName }) {
  return <Box flexDirection="column" width={width} height={rows.length} flexShrink={0}>
    {rows.map((line, index) => <ScreenLine key={index} line={line} width={width} theme={theme} />)}
  </Box>
}

// A streamed token or clock tick must not reconcile every unchanged terminal cell.
const ScreenLine = memo(function ScreenLine({ line, width, theme }: { line: Row; width: number; theme: ThemeName }) {
  const colours = palette(theme)
  return <Box width={width} height={1} flexShrink={0}>
    <Text wrap="truncate-end">{line.spans.map((part, position) => {
      const color = colours[part.tone ?? 'text']
      return <Text key={position}
        {...color === undefined ? {} : { color }}
        bold={part.bold === true} italic={part.italic === true}
        inverse={part.inverse === true} underline={part.underline === true}>
        {part.href === undefined ? part.text : osc8(part.text, part.href)}
      </Text>
    })}</Text>
  </Box>
}, (before, after) => before.width === after.width && before.theme === after.theme
  && (before.line === after.line || (before.line.spans.length === after.line.spans.length
    && before.line.spans.every((part, index) => {
      const next = after.line.spans[index]
      return next !== undefined && part.text === next.text && part.tone === next.tone
        && part.bold === next.bold && part.italic === next.italic && part.inverse === next.inverse
        && part.underline === next.underline && part.href === next.href
    }))))
