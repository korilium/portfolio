const grid = document.getElementById("tools-grid");

function toolCard(tool) {
  return `
    <a href="${tool.href}" class="tool-card-link">
      <article class="tool-card">
        <h3>${tool.title}</h3>
        <p>${tool.description}</p>
        <span class="tool-tag">${tool.tag}</span>
      </article>
    </a>
  `;
}

async function loadTools() {
  try {
    const response = await fetch(`${API_BASE}/tools`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { tools } = await response.json();
    grid.innerHTML = tools.map(toolCard).join("");
  } catch (err) {
    grid.innerHTML = `<p class="playground-error">Couldn't reach the model backend: ${err.message}</p>`;
  }
}

loadTools();
