export interface SearchCriteria {
  name: string;
  country: string;
  activeOnly: boolean;
}

/** Returns a message per invalid field; an empty object means the criteria are valid. */
export function validateSearch(criteria: SearchCriteria): Record<string, string> {
  const errors: Record<string, string> = {};
  const name = criteria.name.trim();
  if (name.length === 0) errors.name = 'Enter a name.';
  else if (name.length < 2) errors.name = 'Enter at least 2 characters.';
  if (criteria.country !== '' && !/^[A-Z]{2}$/.test(criteria.country)) {
    errors.country = 'Use a two-letter country code, such as VN.';
  }
  return errors;
}
