(() => {
  const supported = new Set(['en-GB', 'zh-CN'])
  const aliases = { en: 'en-GB', 'en-us': 'en-GB', 'en-gb': 'en-GB', zh: 'zh-CN', 'zh-cn': 'zh-CN', 'zh-hans': 'zh-CN' }
  const normalise = (value) => supported.has(value) ? value : aliases[String(value || '').trim().toLowerCase()] || 'en-GB'
  const read = () => {
    const query = new URLSearchParams(location.search).get('language')
    if (query) return normalise(query)
    try { return normalise(localStorage.getItem('trip-ticket-language')) } catch { return 'en-GB' }
  }
  const write = (value) => {
    const language = normalise(value)
    try { localStorage.setItem('trip-ticket-language', language) } catch {}
    document.documentElement.lang = language
    document.querySelectorAll('[data-language]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.language === language)))
    document.dispatchEvent(new CustomEvent('trip-ticket-language-change', { detail: { language } }))
    return language
  }
  const carry = (href, language = read()) => {
    const url = new URL(href, location.href)
    url.searchParams.set('language', language)
    return url.href
  }
  document.querySelectorAll('[data-language]').forEach((button) => {
    button.addEventListener('click', () => {
      const language = write(button.dataset.language)
      const url = new URL(location.href)
      url.searchParams.set('language', language)
      history.replaceState(null, '', url)
    })
  })
  globalThis.TripTicketLanguage = { normalise, read, write, carry }
  write(read())
})()
