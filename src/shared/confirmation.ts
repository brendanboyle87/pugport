export type Confirmation = {
  title: string;
  /** Names people chose, filled into the title's {0}, {1}… as written (never translated). */
  names?: readonly string[];
  incognito?: string[];
  summary?: string;
  points?: readonly string[];
  action: string;
  tone?: 'danger';
};
