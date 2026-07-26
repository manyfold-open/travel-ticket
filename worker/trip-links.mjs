export function tripLinks(tripId) {
  const encoded = encodeURIComponent(tripId)
  return {
    self: `/api/trips/${encoded}`,
    connect: `/trips/${encoded}/connect`,
    start: `/api/trips/${encoded}/start`,
    progress: `/trips/${encoded}/progress`,
    result: `/trips/${encoded}/`,
  }
}
