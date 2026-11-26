/**
 * How a map draws a non-detect: the "Non-Detect Display" control.
 *
 * Under ChemDuck's shared rules (aggregate_points), WHICH result a point
 * shows is the dataset's non-detect policy's decision, never the
 * display's: a non-detect is never preferred over a detect because its
 * substituted value happens to be larger. This control only changes how
 * a selected non-detect is drawn (p_display_factor x its limit), or hides
 * points whose selected result is a non-detect.
 *
 * Before, the control picked ChemDuck 0.1's substitution (aggregate_results'
 * nd_method), which also decided the selection, and its default, half the
 * limit, averaged the substitutes with the detects of the same day.
 * Recipes saved with those names still parse: each maps to the nearest
 * display choice here ('raw', the reported value, has none and becomes
 * the policy's).
 */

export type NdDisplay = 'policy' | 'dl' | 'half_dl' | 'zero' | 'exclude';

export const DEFAULT_ND_DISPLAY: NdDisplay = 'policy';

export const ND_DISPLAY_OPTIONS: {name: NdDisplay; label: string; description: string}[] = [
  {
    name: 'policy',
    label: "Dataset's policy",
    description:
      "As the dataset's non-detect policy draws it (ChemDuck's default: at the limit, marked as a non-detect)",
  },
  {name: 'dl', label: 'At the limit', description: 'A selected non-detect drawn at its limit'},
  {name: 'half_dl', label: 'Half the limit', description: 'A selected non-detect drawn at half its limit'},
  {name: 'zero', label: 'Zero', description: 'A selected non-detect drawn at zero'},
  {
    name: 'exclude',
    label: 'Hide non-detects',
    description: 'Points whose selected result is a non-detect are not drawn',
  },
];

/** A stored value as one of the choices; unknown and legacy names become the policy's. */
export function normalizeNdDisplay(value: string | null | undefined): NdDisplay {
  return ND_DISPLAY_OPTIONS.some((o) => o.name === value) ? (value as NdDisplay) : DEFAULT_ND_DISPLAY;
}

/** aggregate_points' p_display_factor for a choice; null leaves the policy's. */
export function ndDisplayFactor(value: string): number | null {
  switch (normalizeNdDisplay(value)) {
    case 'dl':
      return 1;
    case 'half_dl':
      return 0.5;
    case 'zero':
      return 0;
    default:
      return null;
  }
}

/** Whether a choice hides points whose selected result is a non-detect. */
export function ndHides(value: string): boolean {
  return normalizeNdDisplay(value) === 'exclude';
}

/**
 * The event choices aggregate_points takes. 'mean' is ChemDuck's alias for
 * 'statistic' (the policy's over-time statistic: Kaplan–Meier mean under
 * chemduck_default), kept because recipes and the aggregation_rules
 * catalog use it.
 */
export function normalizeEventAgg(value: string | null | undefined): string {
  return value === 'maximum' || value === 'mean' || value === 'statistic' ? value : 'most_recent';
}
