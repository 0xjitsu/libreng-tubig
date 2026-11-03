// Decides which spots are shown, and which water spots count as public taps.
export interface Tags {
  [k: string]: string | undefined;
}

// Words that mark a spot as a public tap or fountain even when it has a name.
const PUBLIC_NAME = /fountain|bubbler|public|gripo|\btap\b|hydration|drinking\s*water/i;
// Names that usually mean a shop selling purified water, not a public tap.
const BUSINESS_NAME = /refill|water|station|purified|distill|mineral|alkaline|geyser|aqua|agua|dew|pure|depot|services?|supplies|enterprises?|trading|alpha|omega/i;
// Operators that look like a business (a school or the LRT is fine).
const BUSINESS_OPERATOR = /water|station|supplies|aqua|refill|purified|enterprises?|trading|services?/i;

/** Private or no-access spots are never shown. */
export const isHidden = (p: Tags): boolean => p.access === 'private' || p.access === 'no';

/** 'water' = public tap or fountain; 'refill' = business, paid, customers-only or unclear. */
export function waterGroup(p: Tags): 'water' | 'refill' {
  if (p.amenity !== 'drinking_water') return 'refill'; // water_point, restaurants, shops, offices
  if (p.fee === 'yes' || p.access === 'customers' || p.access === 'permit') return 'refill';
  if (p.drinking_water === 'refill') return 'refill'; // OSM's own tag for refill stations
  if (p.operator && BUSINESS_OPERATOR.test(p.operator)) return 'refill';
  if (p.name && !PUBLIC_NAME.test(p.name) && BUSINESS_NAME.test(p.name)) return 'refill';
  return 'water';
}
