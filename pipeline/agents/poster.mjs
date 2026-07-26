// Local-only poster prompt. Image generation and filesystem writes remain in
// agents-local.mjs and are not bundled into the deployed Worker.
export function posterPrompt({ city, landmarks = [], palette, slogan = '' }) {
  const landmarkLine = landmarks.length
    ? `Feature these real landmarks and cultural elements of ${city} — accuracy matters, do not invent or substitute others: ${landmarks.join(', ')}.`
    : `Ensure every landmark, architectural style, sign, and cultural element is accurate for ${city} — not universal or incorrect landmarks.`
  return [
    'Create a clean, modern, typographic travel poster in which the name of the city itself becomes a composition.',
    `Highlight the city name ${city.toUpperCase()} in large, bold capital letters without serifs across the entire width of the illustration.`,
    "Integrate the city's most iconic landmarks, architecture, streets, transportation, cultural symbols, and local details into, around, and inside the letters. Let the landmarks interact naturally with the typography while maintaining legibility.",
    'Use an elegant flat vector illustration with clear geometric shapes, minimal details, clear contours, barely noticeable shadows, and excellent editorial aesthetics.',
    `Use a limited color palette built from exactly these tones so the poster feels timeless: deep night ${palette.night}, warm cream ${palette.paper}, vermilion red ${palette.rail}, muted green ${palette.green}.`,
    landmarkLine,
    slogan ? `Include a small elegant slogan under the city name in minimal print-shop type: "${slogan}".` : '',
    'Add small decorative elements only if specific to the city (street lights, trees, birds, trams, ferries).',
    'Maintain voluminous negative space with a clean background and a perfectly balanced composition.',
    'Landscape 3:2 aspect ratio, museum-quality flat vector, centered composition.',
  ].filter(Boolean).join(' ')
}
