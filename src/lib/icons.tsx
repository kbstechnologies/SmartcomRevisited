import {
  CommandLineIcon,
  PlayIcon,
  BoltIcon,
  ServerStackIcon,
  GlobeAltIcon,
  ShieldCheckIcon,
  WrenchScrewdriverIcon,
  ChartBarIcon,
  FolderIcon,
  ClockIcon,
  ArrowPathIcon,
  PowerIcon,
  MagnifyingGlassIcon,
  DocumentTextIcon,
  SignalIcon,
  LockClosedIcon,
} from '@heroicons/react/24/outline'
import type { ComponentType, SVGProps } from 'react'
import { MACRO_ICONS, type MacroIcon } from '@shared/types'

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>

/** Keys mirror MACRO_ICONS so the picker and renderer cannot drift apart. */
export const MACRO_ICON_MAP: Record<MacroIcon, IconComponent> = {
  terminal: CommandLineIcon,
  play: PlayIcon,
  bolt: BoltIcon,
  server: ServerStackIcon,
  globe: GlobeAltIcon,
  shield: ShieldCheckIcon,
  wrench: WrenchScrewdriverIcon,
  chart: ChartBarIcon,
  folder: FolderIcon,
  clock: ClockIcon,
  refresh: ArrowPathIcon,
  power: PowerIcon,
  search: MagnifyingGlassIcon,
  document: DocumentTextIcon,
  signal: SignalIcon,
  lock: LockClosedIcon,
}

export const ICON_NAMES = MACRO_ICONS

export function getMacroIcon(name?: string): IconComponent {
  return MACRO_ICON_MAP[name as MacroIcon] ?? PlayIcon
}

/** Button tints offered alongside the icon picker. */
export const MACRO_COLORS = [
  { name: 'slate', chip: 'bg-slate-600', border: 'border-slate-500' },
  { name: 'blue', chip: 'bg-blue-600', border: 'border-blue-500' },
  { name: 'green', chip: 'bg-green-600', border: 'border-green-500' },
  { name: 'amber', chip: 'bg-amber-600', border: 'border-amber-500' },
  { name: 'red', chip: 'bg-red-600', border: 'border-red-500' },
  { name: 'purple', chip: 'bg-purple-600', border: 'border-purple-500' },
  { name: 'teal', chip: 'bg-teal-600', border: 'border-teal-500' },
  { name: 'pink', chip: 'bg-pink-600', border: 'border-pink-500' },
] as const

export const colorClasses = (color?: string) =>
  MACRO_COLORS.find((entry) => entry.name === color) ?? MACRO_COLORS[0]
