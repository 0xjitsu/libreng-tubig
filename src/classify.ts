// Decides which spots are shown, and which water spots count as public taps.
export interface Tags {
  [k: string]: string | undefined;
}

// Names that usually mean a shop selling purified water, not a public tap.
const BUSINESS_NAME = /refill|water station|purified|distill|mineral|geyser|aqua|agua|water\s*(shop|store|depot)/i;

/** Private or no-access spots are never shown. */
export const isHidden = (p: Tags): boolean => p.access === 'private' || p.access === 'no';

/** 'water' = public tap or fountain; 'refill' = business, paid, customers-only or unclear. */
export function waterGroup(p: Tags): 'water' | 'refill' {
  if (p.amenity !== 'drinking_water') return 'refill'; // water_point, restaurants, shops, offices
  if (p.fee === 'yes' || p.access === 'customers' || p.access === 'permit') return 'refill';
  if (p.name && BUSINESS_NAME.test(p.name)) return 'refill';
  return 'water';
}
