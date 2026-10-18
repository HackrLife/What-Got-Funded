// Country → continent group used across the site. Colours match the brand mark.
export const CONTINENTS = [
  { k: "americas", name: "Americas", color: "#f9a825", dark: true },
  { k: "europe", name: "Europe", color: "#3d5afe" },
  { k: "apac", name: "Asia-Pacific", color: "#00897b" },
  { k: "mideast", name: "Middle East", color: "#e53935" },
  { k: "africa", name: "Africa", color: "#8e24aa" },
  { k: "unknown", name: "Not stated", color: "#9aa3b2" },
];

const MAP = {
  americas: ["United States", "USA", "US", "Canada", "Mexico", "Brazil", "Argentina", "Chile", "Colombia", "Peru", "Uruguay",
    "Ecuador", "Costa Rica", "Panama", "Guatemala", "Dominican Republic", "Puerto Rico", "Venezuela", "Paraguay", "Bolivia",
    "Jamaica", "Cayman Islands", "Bermuda", "Honduras", "El Salvador"],
  europe: ["United Kingdom", "UK", "England", "Scotland", "Wales", "Northern Ireland", "Ireland", "France", "Germany", "Spain",
    "Italy", "Portugal", "Netherlands", "Belgium", "Luxembourg", "Switzerland", "Austria", "Sweden", "Norway", "Denmark",
    "Finland", "Iceland", "Estonia", "Latvia", "Lithuania", "Poland", "Czech Republic", "Czechia", "Slovakia", "Hungary",
    "Romania", "Bulgaria", "Greece", "Croatia", "Slovenia", "Serbia", "Bosnia and Herzegovina", "Montenegro", "North Macedonia",
    "Albania", "Ukraine", "Moldova", "Belarus", "Russia", "Cyprus", "Malta", "Monaco", "Liechtenstein", "Andorra", "Georgia",
    "Armenia", "Azerbaijan", "Kosovo"],
  apac: ["China", "Hong Kong", "Taiwan", "Japan", "South Korea", "Korea", "India", "Pakistan", "Bangladesh", "Sri Lanka", "Nepal",
    "Singapore", "Indonesia", "Malaysia", "Thailand", "Vietnam", "Philippines", "Cambodia", "Myanmar", "Laos", "Australia",
    "New Zealand", "Mongolia", "Kazakhstan", "Uzbekistan", "Kyrgyzstan", "Macau", "Brunei", "Fiji", "Papua New Guinea"],
  mideast: ["Israel", "United Arab Emirates", "UAE", "Saudi Arabia", "Qatar", "Bahrain", "Kuwait", "Oman", "Jordan", "Lebanon",
    "Turkey", "Türkiye", "Iran", "Iraq", "Palestine", "Syria", "Yemen"],
  africa: ["Nigeria", "Kenya", "South Africa", "Egypt", "Morocco", "Ghana", "Tunisia", "Algeria", "Ethiopia", "Rwanda", "Uganda",
    "Tanzania", "Senegal", "Côte d'Ivoire", "Ivory Coast", "Cameroon", "Zambia", "Zimbabwe", "Botswana", "Namibia", "Mozambique",
    "Malawi", "Mauritius", "Benin", "Togo", "Mali", "Burkina Faso", "Niger", "Sudan", "Libya", "Angola", "DR Congo",
    "Democratic Republic of the Congo", "Madagascar", "Sierra Leone", "Liberia", "Gambia", "Somalia", "Seychelles"],
};

const LOOKUP = new Map();
for (const [k, list] of Object.entries(MAP)) for (const c of list) LOOKUP.set(c.toLowerCase(), k);

export function continentOf(country) {
  if (!country) return "unknown";
  return LOOKUP.get(String(country).trim().toLowerCase()) ?? "unknown";
}

// One canonical name per country, so filters and totals don't split "UK" from "United Kingdom"
const ALIAS = { USA: "United States", US: "United States", UK: "United Kingdom", England: "United Kingdom", Scotland: "United Kingdom",
  Wales: "United Kingdom", UAE: "United Arab Emirates", Korea: "South Korea", "Türkiye": "Turkey", Czechia: "Czech Republic",
  "Ivory Coast": "Côte d'Ivoire", "Democratic Republic of the Congo": "DR Congo" };

export function countryLabel(country) {
  if (!country) return "Not stated";
  const c = String(country).trim();
  return ALIAS[c] ?? c;
}
