// A dropdown this page owns.
//
// A native <select> hands its open list to the operating system: that list
// cannot be styled, ignores this page's theme, and looks nothing like anything
// else here. So the control is rebuilt out of a button and a listbox.
//
// It keeps the native contract deliberately — a `value` property and a bubbling
// `change` event — so call sites read `event.target.value` exactly as they
// would against the real element.
(function (root) {
  'use strict'

  const openPickers = new Set()

  function createAgentDropdown({ id, label, options = [], value = '', onChange }) {
    const host = document.createElement('div')
    host.className = 'ui-select'
    host.id = id

    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'ui-select-button'
    button.id = `${id}-button`
    button.setAttribute('role', 'combobox')
    button.setAttribute('aria-haspopup', 'listbox')
    button.setAttribute('aria-expanded', 'false')
    button.setAttribute('aria-controls', `${id}-listbox`)
    button.setAttribute('aria-label', label)

    const valueText = document.createElement('span')
    valueText.className = 'ui-select-value'
    const caret = document.createElement('span')
    // Drawn, not a glyph: an arrow character would change shape with the font.
    caret.className = 'ui-select-caret'
    button.append(valueText, caret)

    const list = document.createElement('ul')
    list.className = 'ui-select-list'
    list.id = `${id}-listbox`
    list.setAttribute('role', 'listbox')
    list.setAttribute('aria-label', label)
    list.hidden = true

    host.append(button, list)

    let current = value
    let items = []

    const optionElements = () => Array.from(list.querySelectorAll('[role="option"]'))

    function paint() {
      const match = items.find(option => option.value === current)
      valueText.textContent = match ? match.label : '— not assigned —'
      for (const element of optionElements()) {
        const selected = element.dataset.value === current
        element.setAttribute('aria-selected', String(selected))
        element.classList.toggle('selected', selected)
      }
    }

    function close() {
      list.hidden = true
      button.setAttribute('aria-expanded', 'false')
      host.classList.remove('open')
      openPickers.delete(host)
    }

    function open() {
      for (const other of Array.from(openPickers)) if (other !== host) other.uiClose()
      list.hidden = false
      button.setAttribute('aria-expanded', 'true')
      host.classList.add('open')
      openPickers.add(host)
      const selected = optionElements().find(element => element.dataset.value === current)
      ;(selected || enabledOptions()[0])?.focus()
    }

    const enabledOptions = () => optionElements().filter(element => element.getAttribute('aria-disabled') !== 'true')

    function commit(next) {
      const changed = current !== next
      current = next
      paint()
      close()
      button.focus()
      if (changed) {
        host.dispatchEvent(new Event('change', { bubbles: true }))
        onChange?.(next)
      }
    }

    // Arrow keys move, Home/End jump, printable characters type-ahead, Enter or
    // Space selects, Escape abandons. Without this the control would be
    // mouse-only, which the element it replaces never was.
    function onKeydown(event) {
      const all = enabledOptions()
      if (!all.length) return
      const focusedIndex = all.indexOf(document.activeElement)
      const index = focusedIndex >= 0
        ? focusedIndex
        : Math.max(0, all.findIndex(element => element.dataset.value === current))

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const next = event.key === 'ArrowDown'
          ? Math.min(all.length - 1, index + 1)
          : Math.max(0, index - 1)
        all[next]?.focus()
        return
      }
      if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault()
        ;(event.key === 'Home' ? all[0] : all[all.length - 1])?.focus()
        return
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        const focused = all[index]
        if (focused) commit(focused.dataset.value)
        return
      }
      if (event.key === 'Escape' || event.key === 'Tab') {
        close()
        if (event.key === 'Escape') {
          event.preventDefault()
          button.focus()
        }
        return
      }
      if (event.key.length === 1 && /\S/.test(event.key)) {
        const needle = event.key.toLowerCase()
        const from = focusedIndex >= 0 ? focusedIndex + 1 : 0
        const order = [...all.slice(from), ...all.slice(0, from)]
        const hit = order.find(element => element.textContent.trim().toLowerCase().startsWith(needle))
        if (hit) {
          event.preventDefault()
          hit.focus()
        }
      }
    }

    function setOptions(next) {
      items = next
      list.replaceChildren(...next.map((option) => {
        const element = document.createElement('li')
        element.setAttribute('role', 'option')
        element.dataset.value = option.value
        element.tabIndex = -1
        element.textContent = option.label
        if (option.hint) {
          const hint = document.createElement('span')
          hint.className = 'ui-select-hint'
          hint.textContent = option.hint
          element.append(hint)
        }
        if (option.disabled) {
          element.setAttribute('aria-disabled', 'true')
          element.classList.add('disabled')
        } else {
          element.addEventListener('click', () => commit(option.value))
        }
        return element
      }))
      paint()
    }

    button.addEventListener('click', () => {
      if (host.classList.contains('open')) close()
      else open()
    })
    button.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        open()
      }
    })
    list.addEventListener('keydown', onKeydown)

    host.uiClose = close
    Object.defineProperty(host, 'value', {
      configurable: true,
      get: () => current,
      set: (next) => commit(String(next)),
    })

    setOptions(options)
    return { element: host, setOptions, setValue: (next) => { current = next; paint() } }
  }

  document.addEventListener('click', (event) => {
    for (const host of Array.from(openPickers)) {
      if (!host.contains(event.target)) host.uiClose()
    }
  })

  root.createAgentDropdown = createAgentDropdown
})(typeof window !== 'undefined' ? window : globalThis)
