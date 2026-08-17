// Mock web search: a small evidence corpus matched by claim pattern. Entries
// carry _verdictHint/_confidenceHint that only the mock LLM judge reads —
// real providers return plain {title,url,snippet}.
const CORPUS = [
  {
    pattern: /(electric vehicle|ev) sales.*(tripl|2020.*2023)|tripl.*(ev|electric vehicle) sales/i,
    title: 'IEA Global EV Outlook 2024',
    url: 'https://www.iea.org/reports/global-ev-outlook-2024',
    snippet: 'Global electric car sales rose from about 3 million in 2020 to almost 14 million in 2023.',
    _verdictHint: 'TRUE',
    _confidenceHint: 0.95,
  },
  {
    pattern: /great wall.*(moon|space)/i,
    title: 'NASA — Great Wall from space',
    url: 'https://www.nasa.gov/vision/space/workinginspace/great_wall.html',
    snippet: 'NASA confirms the Great Wall is not visible from the Moon; no human structures are.',
    _verdictHint: 'FALSE',
    _confidenceHint: 0.97,
  },
  {
    pattern: /emit more carbon|more carbon dioxide than gasoline/i,
    title: 'ICCT lifecycle analysis',
    url: 'https://theicct.org/publication/global-lca-passenger-cars-jul2021/',
    snippet: 'Lifecycle studies find battery-electric cars emit 60-70% less CO2 than gasoline cars, including battery production.',
    _verdictHint: 'FALSE',
    _confidenceHint: 0.92,
  },
  {
    pattern: /emit far less|less co2 than gasoline|lifecycle studies show/i,
    title: 'ICCT lifecycle analysis',
    url: 'https://theicct.org/publication/global-lca-passenger-cars-jul2021/',
    snippet: 'Lifecycle studies find battery-electric cars emit 60-70% less CO2 than gasoline cars, including battery production.',
    _verdictHint: 'TRUE',
    _confidenceHint: 0.93,
  },
  {
    pattern: /norway.*(eighty percent|80|electric)/i,
    title: 'Norwegian Road Federation (OFV) statistics',
    url: 'https://ofv.no/registreringsstatistikk',
    snippet: 'Battery-electric vehicles made up roughly 80-90% of new car registrations in Norway in recent years.',
    _verdictHint: 'TRUE',
    _confidenceHint: 0.9,
  },
  {
    pattern: /unemployment.*(lowest|history)/i,
    title: 'Statistics Norway / OECD unemployment data',
    url: 'https://www.ssb.no/en/arbeid-og-lonn',
    snippet: 'Unemployment is near multi-decade lows but not the lowest ever recorded.',
    _verdictHint: 'MISLEADING',
    _confidenceHint: 0.88,
  },
];

export function createMockSearchProvider({ latencyMs = 30 } = {}) {
  return {
    kind: 'mock',
    async search(query, { maxResults = 5 } = {}) {
      await new Promise((r) => setTimeout(r, latencyMs));
      return CORPUS.filter((e) => e.pattern.test(query))
        .slice(0, maxResults)
        .map(({ pattern, ...rest }) => rest);
    },
  };
}
