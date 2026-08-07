/**
 * Cadence design tokens — navy field, gold accent, clean cards. Carried over
 * from the original Corps Central palette so the product stays recognizably
 * Cadence in both light and dark modes.
 */
export const brand = {
  navy: '#0a3f6b',
  navyDeep: '#072c4b',
  gold: '#f0b429',
  goldSoft: '#f5c24a',
  amber: '#d97706',
  red: '#e03131',
};

export interface Theme {
  dark: boolean;
  page: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  text: string;
  textSecondary: string;
  muted: string;
  navy: string;
  gold: string;
  accent: string;
  positive: string;
  negative: string;
  headerBg: string;
  headerText: string;
  tabBar: string;
}

export const lightTheme: Theme = {
  dark: false,
  page: '#f2f4f8',
  surface: '#ffffff',
  surfaceAlt: '#eef1f6',
  border: '#e4e9f1',
  text: '#16233d',
  textSecondary: '#3f4c63',
  muted: '#74808f',
  navy: brand.navy,
  gold: brand.gold,
  accent: brand.amber,
  positive: '#0f7b3d',
  negative: brand.red,
  headerBg: brand.navy,
  headerText: '#ffffff',
  tabBar: '#ffffff',
};

export const darkTheme: Theme = {
  dark: true,
  page: '#0d1420',
  surface: '#161f2e',
  surfaceAlt: '#1d2839',
  border: '#273349',
  text: '#e8edf5',
  textSecondary: '#b7c1d1',
  muted: '#8b95a4',
  navy: brand.navy,
  gold: brand.gold,
  accent: brand.goldSoft,
  positive: '#4ade80',
  negative: '#f87171',
  headerBg: brand.navyDeep,
  headerText: '#ffffff',
  tabBar: '#111927',
};

export const spacing = (n: number) => n * 4;

export const radius = { sm: 8, md: 12, lg: 16 };

export const type = {
  title: 22,
  heading: 17,
  body: 15,
  small: 13,
  tiny: 11,
  score: 20,
};
