const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const stageNames = {
  selection: 'Sélection',
  lab_availability: 'Disponibilité au labo',
  sample_weighing: 'Pesée de l’échantillon',
  reweigh: 'Re-pesée à partir de zéro',
  sample_evaluation: 'Évaluation olfactive',
  commercial_review: 'Validation commerciale',
  client_sample: 'Échantillon client'
};
const stageKeys = Object.keys(stageNames);
const roleNames = { commercial: 'Commercial', assistant_commercial: 'Assistant commercial', parfumeur: 'Parfumeur', a_classer: 'À classer' };
const roleDom = { commercial: 'commercial', assistant_commercial: 'assistant-commercial', parfumeur: 'parfumeur' };
const statusNames = { in_progress: 'En cours', finished: 'Terminé' };
const decisionNames = { pending: 'En attente', won: 'Gagné', lost: 'Perdu' };
const state = {
  projects: [], people: [], references: [], selectedPeople: { commercial: [], assistant_commercial: [], parfumeur: [] },
  selectedUnclassified: [], selectedReferences: [], quickFilter: null, page: 'overview', calendarOffset: 0, activeProject: null
};

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initials = value => String(value || '?').trim().split(/\s+/).slice(0, 2).map(s => s[0]?.toLocaleUpperCase('fr-FR') || '').join('');
const dateLocal = value => { if (!value) return null; const [year, month, day] = String(value).slice(0, 10).split('-').map(Number); return new Date(year, month - 1, day); };
const dateISO = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const dateLabel = value => value ? new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }).format(dateLocal(value)).replace('.', '') : '';
const dateDistance = value => { const due = dateLocal(value); if (!due) return null; const today = new Date(); today.setHours(0, 0, 0, 0); return Math.round((due - today) / 86400000); };
const moneyLabel = amount => amount == null || amount === '' ? 'Non renseigné' : new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(Number(amount));

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, { headers: { 'Content-Type': 'application/json' }, ...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'La requête n’a pas abouti.');
  return payload;
}

function notify(message) {
  const toast = $('#toast'); toast.textContent = message; toast.classList.add('visible');
  clearTimeout(notify.timer); notify.timer = setTimeout(() => toast.classList.remove('visible'), 2800);
}

function setToday() {
  $('#today-label').textContent = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
}

function deadlineInfo(project) {
  if (!project.deadline) return { text: 'Sans deadline', cls: 'no-deadline', card: '' };
  if (project.status === 'finished') return { text: `Échéance · ${dateLabel(project.deadline)}`, cls: '', card: '' };
  const distance = dateDistance(project.deadline);
  if (distance < 0) return { text: `En retard · ${dateLabel(project.deadline)}`, cls: 'overdue', card: 'is-overdue' };
  if (distance === 0) return { text: 'Échéance aujourd’hui', cls: 'today', card: 'is-soon' };
  if (distance === 1) return { text: 'Échéance demain', cls: 'soon', card: 'is-soon' };
  if (distance <= 7) return { text: `Dans ${distance} jours · ${dateLabel(project.deadline)}`, cls: 'soon', card: 'is-soon' };
  return { text: `Échéance · ${dateLabel(project.deadline)}`, cls: '', card: '' };
}

function visibleProjects() {
  const search = $('#search').value.trim().toLocaleLowerCase('fr-FR');
  const status = $('#status-filter').value;
  const decision = $('#decision-filter').value;
  return state.projects.filter(project => {
    if (state.quickFilter === 'in_progress' && project.status !== 'in_progress') return false;
    if (state.quickFilter === 'finished' && project.status !== 'finished') return false;
    if (status !== 'all' && project.status !== status) return false;
    if (decision !== 'all' && project.decision !== decision) return false;
    const participants = (project.participants || []).map(person => person.name);
    const refs = (project.references || []).map(reference => reference.label);
    const haystack = [project.title, project.client, project.brief, ...participants, ...refs].join(' ').toLocaleLowerCase('fr-FR');
    return !search || haystack.includes(search);
  });
}

function renderStats() {
  const active = state.projects.filter(p => p.status === 'in_progress');
  const due = active.filter(p => p.deadline && dateDistance(p.deadline) <= 7);
  $('#stat-active').textContent = active.length;
  $('#stat-due').textContent = due.length;
  $('#stat-finished').textContent = state.projects.filter(p => p.status === 'finished').length;
  $('#nav-count').textContent = state.projects.length;
}

function projectBadges(project, { showDecision = true } = {}) {
  const decision = showDecision ? `<span class="badge badge-decision ${esc(project.decision)}">${esc(decisionNames[project.decision] || 'En attente')}</span>` : '';
  return `<span class="badge badge-stage"><small>ÉTAPE EN COURS</small><strong>${esc(stageNames[project.stage] || stageNames.selection)}</strong></span><span class="badge badge-status ${project.status === 'finished' ? 'finished' : ''}">${esc(statusNames[project.status] || project.status)}</span>${decision}`;
}

function renderCard(project) {
  const timing = deadlineInfo(project);
  const people = (project.participants || []).slice(0, 3).map(person => `<span class="mini-avatar role-${esc(person.role || 'parfumeur')}" title="${esc(`${roleNames[person.role] || 'Parfumeur'} · ${person.name}`)}">${esc(initials(person.name))}</span>`).join('');
  const extra = (project.participants || []).length > 3 ? `<span class="mini-avatar more">+${project.participants.length - 3}</span>` : '';
  const pinned = project.dashboard_note?.body ? `<div class="pinned-note"><span class="pin-mark">⌖</span>${esc(project.dashboard_note.body)}</div>` : '';
  const rmc = project.rmc_amount == null ? '' : `<span class="rmc-chip">RMC ${esc(moneyLabel(project.rmc_amount))}</span>`;
  return `<article class="project-card ${timing.card}" data-project="${esc(project.id)}" tabindex="0" role="button" aria-label="Ouvrir ${esc(project.title)}">
    <div class="card-top"><div class="project-identity"><span class="project-monogram">${esc(initials(project.title).slice(0, 1))}</span><div style="min-width:0"><h3 class="project-title">${esc(project.title)}</h3><div class="project-client">${esc(project.client || 'Client à préciser')}</div></div></div><button class="card-menu" type="button" data-edit="${esc(project.id)}" aria-label="Modifier ce projet" title="Modifier">···</button></div>
    <div class="card-badges">${projectBadges(project, { showDecision: false })}</div><p class="project-summary">${esc(project.brief || 'Ajoutez un résumé personnel pour retrouver le contexte en un coup d’œil.')}</p>${rmc}
    <div class="project-meta"><span class="deadline ${timing.cls}"><span class="deadline-icon">◷</span>${esc(timing.text)}</span><div class="card-people" title="${esc((project.participants || []).map(p => `${roleNames[p.role] || 'Parfumeur'} · ${p.name}`).join(', '))}">${people}${extra}</div></div>
    ${pinned}<div class="card-foot"><button class="note-link" type="button" data-open-notes="${esc(project.id)}"><span class="note-mark">▤</span>${project.note_count || 0} note${project.note_count === 1 ? '' : 's'}</button>${(project.references || []).length ? `<span class="note-link"><span class="note-mark">◉</span>${project.references.length} réf.</span>` : ''}</div>
  </article>`;
}

function renderProjectGrid() {
  const projects = visibleProjects();
  $('#result-count').textContent = `${projects.length} projet${projects.length > 1 ? 's' : ''}`;
  $('#result-context').textContent = state.quickFilter ? ({ in_progress: 'Projets en cours', finished: 'Projets terminés' }[state.quickFilter]) : 'Tous vos projets';
  $('#project-grid').innerHTML = projects.map(renderCard).join('');
  const empty = $('#empty-state'); empty.classList.toggle('hidden', projects.length !== 0);
  if (state.projects.length && !projects.length) {
    $('.empty-state h3').textContent = 'Aucun résultat'; $('.empty-state p').textContent = 'Essayez de modifier votre recherche ou vos filtres.'; $('#empty-create').classList.add('hidden');
  } else {
    $('.empty-state h3').textContent = 'Un espace à composer'; $('.empty-state p').textContent = 'Ajoutez votre premier projet pour commencer à organiser votre suivi.'; $('#empty-create').classList.remove('hidden');
  }
}

function mondayOf(date) {
  const monday = new Date(date); monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7) + state.calendarOffset * 7);
  return monday;
}

function renderCalendar() {
  const monday = mondayOf(new Date());
  const sunday = new Date(monday); sunday.setDate(sunday.getDate() + 6);
  const startLabel = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long' }).format(monday);
  const endLabel = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }).format(sunday);
  $('#calendar-range').textContent = state.calendarOffset === 0 ? `Cette semaine · ${startLabel} – ${endLabel}` : `${startLabel} – ${endLabel}`;
  $('#calendar-today').classList.toggle('hidden', state.calendarOffset === 0);
  const today = dateISO(new Date());
  const days = Array.from({ length: 7 }, (_, index) => { const day = new Date(monday); day.setDate(monday.getDate() + index); return day; });
  $('#week-calendar').innerHTML = days.map(day => {
    const iso = dateISO(day);
    const projects = state.projects.filter(project => project.status === 'in_progress' && project.deadline && String(project.deadline).slice(0, 10) === iso);
    const weekday = new Intl.DateTimeFormat('fr-FR', { weekday: 'short' }).format(day).replace('.', '');
    const entries = projects.map(project => `<button class="calendar-project" type="button" data-open-project="${esc(project.id)}"><strong>${esc(project.title)}</strong><small>${esc(project.client || stageNames[project.stage] || 'Projet')}</small></button>`).join('');
    return `<section class="calendar-day ${iso === today ? 'is-today' : ''} ${projects.length ? 'has-projects' : ''}"><header><span>${esc(weekday)}</span><strong>${day.getDate()}</strong></header><div class="calendar-day-projects">${entries || '<span class="calendar-no-project">—</span>'}</div></section>`;
  }).join('');
}

function renderOverview() {
  renderCalendar();
}

function render() { renderStats(); renderProjectGrid(); renderOverview(); }

async function refresh() {
  const [projects, people, references] = await Promise.all([api('/projects'), api('/participants'), api('/references')]);
  state.projects = projects; state.people = people; state.references = references;
  render();
  if ($('#project-modal').open) { renderTokens(); Object.keys(roleDom).forEach(renderPeoplePicker); renderReferencePicker(); }
}

function showPage(page) {
  state.page = page; if (page === 'overview') state.quickFilter = null;
  $('#overview-page').classList.toggle('hidden', page !== 'overview'); $('#projects-page').classList.toggle('hidden', page !== 'projects');
  $('#page-title').innerHTML = `${page === 'overview' ? 'Vue d’ensemble' : 'Tous les projets'}<span class="title-period">.</span>`;
  $('#page-subtitle').textContent = page === 'overview' ? 'Vos échéances et vos prochaines actions, au même endroit.' : 'Retrouvez, filtrez et ouvrez chaque fiche projet.';
  $('#breadcrumb-page').textContent = page === 'overview' ? 'Vue d’ensemble' : 'Tous les projets';
  $$('.nav-item').forEach(item => item.classList.remove('active'));
  if (page === 'overview') $('#nav-overview').classList.add('active');
  else if (!state.quickFilter) $('#nav-all').classList.add('active'); else $(`[data-quick-filter="${state.quickFilter}"]`)?.classList.add('active');
  render();
}

function emptyPeopleSelection() { return { commercial: [], assistant_commercial: [], parfumeur: [] }; }

function showProjectModal(project = null) {
  $('#project-form').reset(); $('#project-id').value = project?.id || '';
  $('#project-modal-title').textContent = project ? 'Modifier le projet' : 'Nouveau projet';
  $('#project-title').value = project?.title || ''; $('#project-client').value = project?.client || '';
  $('#project-stage-label').value = stageNames[project?.stage] || 'Sélection';
  $('#project-status').value = project?.status || 'in_progress'; $('#project-decision').value = project?.decision || 'pending';
  $('#project-deadline').value = project?.deadline ? String(project.deadline).slice(0, 10) : '';
  $('#project-rmc').value = project?.rmc_amount ?? ''; $('#project-brief').value = project?.brief || '';
  state.selectedPeople = emptyPeopleSelection();
  state.selectedUnclassified = [];
  for (const person of project?.participants || []) {
    if (person.role === 'a_classer') state.selectedUnclassified.push(person.name);
    else (state.selectedPeople[person.role] || state.selectedPeople.parfumeur).push(person.name);
  }
  state.selectedReferences = (project?.references || []).map(r => r.label);
  renderTokens(); Object.keys(roleDom).forEach(renderPeoplePicker); renderReferencePicker();
  $('#project-modal').showModal(); setTimeout(() => $('#project-title').focus(), 80);
}

function renderTokens() {
  for (const role of Object.keys(roleNames)) {
    if (!state.selectedPeople[role]) continue;
    $(`#people-${roleDom[role]}-tokens`).innerHTML = state.selectedPeople[role].map((name, index) => `<span class="token role-token-${role}">${esc(name)}<button type="button" aria-label="Retirer ${esc(name)}" data-remove-person="${role}" data-index="${index}">×</button></span>`).join('');
  }
  $('#people-unclassified-tokens').innerHTML = state.selectedUnclassified.map((name, index) => `<span class="token legacy-token">${esc(name)}<button type="button" aria-label="Retirer ${esc(name)} du projet" data-remove-unclassified="${index}">×</button></span>`).join('');
  $('#unclassified-people-field').classList.toggle('hidden', state.selectedUnclassified.length === 0);
  $('#reference-tokens').innerHTML = state.selectedReferences.map((name, index) => `<span class="token">${esc(name)}<button type="button" aria-label="Retirer ${esc(name)}" data-remove-token="references" data-index="${index}">×</button></span>`).join('');
}

function personInput(role) { return $(`#people-${roleDom[role]}-input`); }
function personMenu(role) { return $(`#people-${roleDom[role]}-picker`); }

function renderPeoplePicker(role) {
  const input = personInput(role); const menu = personMenu(role); const query = input.value.trim().toLocaleLowerCase('fr-FR');
  const selected = state.selectedPeople[role];
  const matches = state.people.filter(person => (person.role === role || person.role === 'a_classer') && !selected.some(name => name.toLocaleLowerCase('fr-FR') === person.name.toLocaleLowerCase('fr-FR')) && person.name.toLocaleLowerCase('fr-FR').includes(query));
  menu.innerHTML = matches.length ? matches.map(person => `<div class="picker-option" role="option"><button type="button" class="picker-select" data-pick-person="${role}" data-person-id="${esc(person.id)}">${esc(person.name)}<small>${person.role === 'a_classer' ? 'À classer · ' : ''}${person.project_count || 0} projet${person.project_count === 1 ? '' : 's'}</small></button><button type="button" class="picker-delete" data-delete-library="people" data-library-id="${esc(person.id)}" data-library-name="${esc(person.name)}" data-library-role="${esc(person.role)}" data-project-count="${person.project_count || 0}" aria-label="Supprimer ${esc(person.name)} de la liste">×</button></div>`).join('') : `<div class="picker-empty">${query ? 'Aucun résultat. Utilisez « Ajouter » pour créer ce contact.' : 'Aucun contact de ce rôle enregistré.'}</div>`;
}

function renderReferencePicker() {
  const input = $('#references-input'); const menu = $('#references-picker'); const query = input.value.trim().toLocaleLowerCase('fr-FR');
  const matches = state.references.filter(reference => !state.selectedReferences.some(name => name.toLocaleLowerCase('fr-FR') === reference.label.toLocaleLowerCase('fr-FR')) && reference.label.toLocaleLowerCase('fr-FR').includes(query));
  menu.innerHTML = matches.length ? matches.map(reference => `<div class="picker-option" role="option"><button type="button" class="picker-select" data-pick-reference="${esc(reference.id)}">${esc(reference.label)}<small>${reference.project_count || 0} projet${reference.project_count === 1 ? '' : 's'}</small></button><button type="button" class="picker-delete" data-delete-library="references" data-library-id="${esc(reference.id)}" data-library-name="${esc(reference.label)}" data-project-count="${reference.project_count || 0}" aria-label="Supprimer ${esc(reference.label)} de la liste">×</button></div>`).join('') : `<div class="picker-empty">${query ? 'Aucun résultat. Utilisez « Ajouter » pour créer cette référence.' : 'Aucune référence enregistrée.'}</div>`;
}

function renderDetailReferencePicker() {
  const project = state.projects.find(item => item.id === state.activeProject); if (!project) return;
  const input = $('#detail-reference-input'); const menu = $('#detail-reference-picker');
  const query = input.value.trim().toLocaleLowerCase('fr-FR');
  const selected = (project.references || []).map(reference => reference.label.toLocaleLowerCase('fr-FR'));
  const matches = state.references.filter(reference => !selected.includes(reference.label.toLocaleLowerCase('fr-FR')) && reference.label.toLocaleLowerCase('fr-FR').includes(query));
  menu.innerHTML = matches.length ? matches.map(reference => `<div class="picker-option" role="option"><button type="button" class="picker-select" data-pick-detail-reference="${esc(reference.id)}">${esc(reference.label)}<small>${reference.project_count || 0} projet${reference.project_count === 1 ? '' : 's'}</small></button><button type="button" class="picker-delete" data-delete-library="references" data-library-id="${esc(reference.id)}" data-library-name="${esc(reference.label)}" data-project-count="${reference.project_count || 0}" aria-label="Supprimer ${esc(reference.label)} de la liste">×</button></div>`).join('') : `<div class="picker-empty">${query ? 'Aucune référence existante. Cliquez sur Ajouter pour la créer.' : 'Toutes les références enregistrées sont déjà associées à ce projet.'}</div>`;
}

function openPersonPicker(role) { renderPeoplePicker(role); personMenu(role).classList.remove('hidden'); personInput(role).setAttribute('aria-expanded', 'true'); }
function openReferencePicker() { renderReferencePicker(); $('#references-picker').classList.remove('hidden'); $('#references-input').setAttribute('aria-expanded', 'true'); }
function openDetailReferencePicker() { renderDetailReferencePicker(); $('#detail-reference-picker').classList.remove('hidden'); $('#detail-reference-input').setAttribute('aria-expanded', 'true'); }
function closePickers() { $$('.picker-menu').forEach(menu => menu.classList.add('hidden')); $$('input[aria-expanded]').forEach(input => input.setAttribute('aria-expanded', 'false')); }

function addPerson(role, value = null) {
  const input = personInput(role); const selected = state.selectedPeople[role];
  const name = String(value ?? input.value).trim().replace(/\s+/g, ' '); if (!name) return;
  if (selected.some(item => item.toLocaleLowerCase('fr-FR') === name.toLocaleLowerCase('fr-FR'))) { notify('Ce contact est déjà ajouté.'); input.value = ''; return; }
  state.selectedUnclassified = state.selectedUnclassified.filter(item => item.toLocaleLowerCase('fr-FR') !== name.toLocaleLowerCase('fr-FR'));
  selected.push(name); input.value = ''; renderTokens(); openPersonPicker(role); input.focus();
}

function addReference(value = null) {
  const input = $('#references-input'); const label = String(value ?? input.value).trim().replace(/\s+/g, ' '); if (!label) return;
  if (state.selectedReferences.some(item => item.toLocaleLowerCase('fr-FR') === label.toLocaleLowerCase('fr-FR'))) { notify('Cette référence est déjà ajoutée.'); input.value = ''; return; }
  state.selectedReferences.push(label); input.value = ''; renderTokens(); openReferencePicker(); input.focus();
}

async function addProjectReference(value = null) {
  const project = state.projects.find(item => item.id === state.activeProject); if (!project) return;
  const input = $('#detail-reference-input'); const label = String(value ?? input.value).trim().replace(/\s+/g, ' '); if (!label) return;
  if ((project.references || []).some(reference => reference.label.toLocaleLowerCase('fr-FR') === label.toLocaleLowerCase('fr-FR'))) { notify('Cette référence est déjà associée au projet.'); input.value = ''; return; }
  try {
    const references = [...(project.references || []).map(reference => reference.label), label];
    await api(`/projects/${project.id}/references`, { method: 'PUT', body: JSON.stringify({ references }) });
    await refresh(); await openDetail(project.id); notify('Référence ajoutée au projet.');
  } catch (error) { notify(error.message); }
}

async function removeProjectReference(referenceId) {
  const project = state.projects.find(item => item.id === state.activeProject); if (!project) return;
  try {
    const references = (project.references || []).filter(reference => reference.id !== referenceId).map(reference => reference.label);
    await api(`/projects/${project.id}/references`, { method: 'PUT', body: JSON.stringify({ references }) });
    await refresh(); await openDetail(project.id); notify('Référence retirée de ce projet.');
  } catch (error) { notify(error.message); }
}

async function saveProject(event) {
  event.preventDefault(); const id = $('#project-id').value;
  const participants = Object.entries(state.selectedPeople).flatMap(([role, names]) => names.map(name => ({ name, role }))).concat(state.selectedUnclassified.map(name => ({ name, role: 'a_classer' })));
  const payload = {
    title: $('#project-title').value.trim(), client: $('#project-client').value.trim(), stage: state.projects.find(p => p.id === id)?.stage || 'selection',
    status: $('#project-status').value, decision: $('#project-decision').value, deadline: $('#project-deadline').value || null,
    rmc_amount: $('#project-rmc').value || null, brief: $('#project-brief').value.trim(), participants, references: state.selectedReferences
  };
  try {
    const saved = await api(id ? `/projects/${id}` : '/projects', { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
    $('#project-modal').close(); await refresh(); notify(id ? 'Projet mis à jour.' : 'Projet ajouté à votre suivi.'); await openDetail(saved.id);
  } catch (error) { notify(error.message); }
}

function contactGroup(project, role) {
  const entries = (project.participants || []).filter(person => (person.role || 'parfumeur') === role);
  if (role === 'a_classer' && !entries.length) return '';
  return `<div class="contact-group contact-${role}"><small>${esc(roleNames[role])}${role === 'parfumeur' && entries.length !== 1 ? 's' : ''}</small><div>${entries.length ? entries.map(person => `<span class="detail-tag">${esc(person.name)}</span>`).join('') : '<span class="contact-empty">À désigner</span>'}</div></div>`;
}

function stageAction(project) {
  const id = esc(project.id);
  if (project.stage === 'selection') return `<button class="stage-next" type="button" data-advance="lab_availability">Demander la disponibilité au labo <span>→</span></button>`;
  if (project.stage === 'lab_availability') return `<div class="stage-choices"><button class="stage-next" type="button" data-advance="sample_weighing">Référence disponible · demander la pesée <span>→</span></button><button class="stage-next stage-alt" type="button" data-advance="reweigh">Référence indisponible · re-peser de zéro <span>→</span></button></div>`;
  if (project.stage === 'sample_weighing' || project.stage === 'reweigh') return `<button class="stage-next" type="button" data-advance="sample_evaluation">Échantillon prêt · passer à l’évaluation olfactive <span>→</span></button>`;
  if (project.stage === 'sample_evaluation') return `<button class="stage-next" type="button" data-advance="commercial_review">Échantillon validé · présenter au commercial <span>→</span></button><p class="stage-guidance">Si l’échantillon n’est pas validé, recommencez à la sélection et notez la raison.</p>`;
  if (project.stage === 'commercial_review') return `<button class="stage-next" type="button" data-advance="client_sample">Commercial a validé · demander l’échantillon client <span>→</span></button><p class="stage-guidance">Si le commercial ne valide pas, recommencez à la sélection et notez la raison.</p>`;
  return `<div class="stage-finished">Dernière étape du circuit. Vous pouvez mettre le projet au statut « Terminé » depuis Modifier.</div>`;
}

async function openDetail(id) {
  const project = state.projects.find(p => p.id === id); if (!project) return;
  state.activeProject = id; const notes = await api(`/projects/${id}/notes`); const timing = deadlineInfo(project);
  const noteList = notes.length ? notes.map(note => `<article class="note-item"><p>${esc(note.body)}</p><small>${esc(new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(note.created_at)))}${note.show_on_dashboard ? '<span class="note-pin">⌖ Affichée sur le tableau</span>' : ''}</small></article>`).join('') : '<div class="notes-empty">Aucune note pour le moment. Gardez ici vos observations, même après la fin du projet.</div>';
  const referenceTags = (project.references || []).length ? project.references.map(r => `<span class="detail-tag reference-detail-tag">${esc(r.label)}<button type="button" data-remove-project-reference="${esc(r.id)}" aria-label="Retirer ${esc(r.label)} de ce projet">×</button></span>`).join('') : '<span class="notes-empty">Aucune référence ajoutée pour le moment.</span>';
  $('#detail-content').innerHTML = `<div class="detail-wrap">
    <div class="detail-topline"><div><div class="eyebrow"><span class="eyebrow-line"></span> FICHE PROJET</div><h2 class="detail-title">${esc(project.title)}</h2><div class="detail-client">${esc(project.client || 'Client à préciser')}</div></div><div class="detail-actions"><button class="button button-quiet" type="button" data-detail-edit="${esc(id)}">Modifier</button><button class="icon-button" type="button" data-close="detail-modal" aria-label="Fermer">×</button></div></div>
    <div class="card-badges">${projectBadges(project)}</div>
    <div class="detail-meta-grid"><div class="detail-meta"><small>ÉTAPE DU PROJET</small><strong>${esc(stageNames[project.stage] || 'Sélection')}</strong></div><div class="detail-meta"><small>DEADLINE</small><strong class="deadline ${timing.cls}">${esc(timing.text)}</strong></div><div class="detail-meta"><small>RMC · COÛT TOTAL</small><strong>${esc(moneyLabel(project.rmc_amount))}</strong></div></div>
    <section class="detail-section"><h3>Références sélectionnées</h3><div class="detail-tags" id="detail-reference-tags">${referenceTags}</div><div class="detail-reference-editor picker-wrap"><div class="reference-entry"><input id="detail-reference-input" autocomplete="off" placeholder="Choisir ou ajouter une référence…" aria-expanded="false" aria-controls="detail-reference-picker"><button type="button" class="add-token" data-add-project-reference>Ajouter</button></div><div class="picker-menu hidden" id="detail-reference-picker" role="listbox" aria-label="Références disponibles"></div></div><small class="reference-help">Ajoutez les références dès la sélection, puis avancez le projet quand vous êtes prête.</small></section>
    <section class="detail-section stage-panel"><div class="section-heading detail-section-heading"><div><h3>Étape actuelle</h3><p>Avancez le projet quand l’action est terminée.</p></div><span class="stage-counter">${stageKeys.indexOf(project.stage) + 1} / ${stageKeys.length}</span></div><div class="stage-progress"><i style="width:${Math.max(8, ((stageKeys.indexOf(project.stage) + 1) / stageKeys.length) * 100)}%"></i></div><div class="stage-current-name">${esc(stageNames[project.stage] || 'Sélection')}</div>${stageAction(project)}<button class="restart-link" type="button" data-restart="${esc(id)}">Recommencer à la sélection</button></section>
    <section class="detail-section"><div class="section-heading detail-section-heading"><div><h3>Équipe projet</h3><p>Les parfumeurs peuvent être ajoutés ou modifiés plus tard.</p></div><button class="text-button" type="button" data-detail-edit="${esc(id)}">Modifier l’équipe</button></div><div class="contact-groups">${contactGroup(project, 'commercial')}${contactGroup(project, 'assistant_commercial')}${contactGroup(project, 'parfumeur')}${contactGroup(project, 'a_classer')}</div></section>
    <section class="detail-section"><h3>Résumé personnel</h3><div class="detail-copy">${project.brief ? esc(project.brief) : 'Aucun résumé ajouté.'}</div></section>
    <section class="detail-section"><h3>Notes personnelles <span class="note-count">· ${notes.length}</span></h3><div class="notes-list">${noteList}</div><form class="note-form" id="note-form"><textarea name="body" required maxlength="10000" placeholder="Une observation, une idée à garder, une prochaine action…"></textarea><div class="note-form-bottom"><label class="check-label"><input type="checkbox" name="show_on_dashboard"> Afficher sur le tableau de bord</label><button class="button button-primary" type="submit">Ajouter la note <span>→</span></button></div></form></section>
    <div class="modal-actions"><button class="button button-quiet" type="button" data-delete="${esc(id)}">Supprimer le projet</button></div>
  </div>`;
  $('#detail-modal').showModal();
}

async function saveNote(event) {
  if (!event.target.matches('#note-form')) return; event.preventDefault(); const data = new FormData(event.target);
  try { await api(`/projects/${state.activeProject}/notes`, { method: 'POST', body: JSON.stringify({ body: data.get('body'), show_on_dashboard: data.has('show_on_dashboard') }) }); await refresh(); await openDetail(state.activeProject); notify('Note enregistrée.'); }
  catch (error) { notify(error.message); }
}

async function advanceProject(id, stage) {
  try { await api(`/projects/${id}/advance`, { method: 'POST', body: JSON.stringify({ stage }) }); await refresh(); await openDetail(id); notify(`Étape mise à jour : ${stageNames[stage]}.`); }
  catch (error) { notify(error.message); }
}

async function restartWorkflow(id) {
  if (!window.confirm('Recommencer ce projet depuis la sélection ?')) return;
  const note = window.prompt('Ajouter une note expliquant pourquoi le projet recommence ? (facultatif)', '') || '';
  try { await api(`/projects/${id}/restart`, { method: 'POST', body: JSON.stringify({ note }) }); await refresh(); await openDetail(id); notify(note.trim() ? 'Projet recommencé et note ajoutée.' : 'Projet recommencé depuis la sélection.'); }
  catch (error) { notify(error.message); }
}

async function deleteProject(id) {
  const project = state.projects.find(p => p.id === id); if (!window.confirm(`Supprimer « ${project?.title || 'ce projet'} » et ses notes ?`)) return;
  try { await api(`/projects/${id}`, { method: 'DELETE' }); $('#detail-modal').close(); state.activeProject = null; await refresh(); notify('Projet supprimé.'); }
  catch (error) { notify(error.message); }
}

async function deleteLibraryItem(kind, id, label, count, role = null) {
  const description = kind === 'people' ? `${roleNames[role] || 'Contact'} « ${label} »` : `référence « ${label} »`;
  const usages = Number(count) ? ` Cette suppression le retirera aussi des ${count} projet${Number(count) === 1 ? '' : 's'} où il est utilisé.` : '';
  if (!window.confirm(`Supprimer ${description} de la liste ?${usages}`)) return;
  try {
    await api(`/${kind === 'people' ? 'participants' : 'references'}/${id}`, { method: 'DELETE' });
    if (kind === 'people' && role === 'a_classer') state.selectedUnclassified = state.selectedUnclassified.filter(name => name.toLocaleLowerCase('fr-FR') !== label.toLocaleLowerCase('fr-FR'));
    else if (kind === 'people') state.selectedPeople[role] = state.selectedPeople[role].filter(name => name.toLocaleLowerCase('fr-FR') !== label.toLocaleLowerCase('fr-FR'));
    else state.selectedReferences = state.selectedReferences.filter(name => name.toLocaleLowerCase('fr-FR') !== label.toLocaleLowerCase('fr-FR'));
    await refresh();
    if (kind === 'references' && $('#detail-modal').open && state.activeProject) await openDetail(state.activeProject);
    notify('Entrée supprimée de la liste.');
  } catch (error) { notify(error.message); }
}

function showPage(page) {
  state.quickFilter = page === 'overview' ? null : state.quickFilter; state.page = page;
  $('#overview-page').classList.toggle('hidden', page !== 'overview'); $('#projects-page').classList.toggle('hidden', page !== 'projects');
  $('#page-title').innerHTML = `${page === 'overview' ? 'Vue d’ensemble' : 'Tous les projets'}<span class="title-period">.</span>`;
  $('#page-subtitle').textContent = page === 'overview' ? 'Vos échéances et vos prochaines actions, au même endroit.' : 'Retrouvez, filtrez et ouvrez chaque fiche projet.';
  $('#breadcrumb-page').textContent = page === 'overview' ? 'Vue d’ensemble' : 'Tous les projets';
  $$('.nav-item').forEach(item => item.classList.remove('active'));
  if (page === 'overview') $('#nav-overview').classList.add('active'); else if (!state.quickFilter) $('#nav-all').classList.add('active'); else $(`[data-quick-filter="${state.quickFilter}"]`)?.classList.add('active');
  render();
}

$('#project-form').addEventListener('submit', saveProject);
$('#detail-content').addEventListener('submit', saveNote);
$('#detail-content').addEventListener('click', event => {
  const advance = event.target.closest('[data-advance]'); if (advance) advanceProject(state.activeProject, advance.dataset.advance);
  const addReferenceButton = event.target.closest('[data-add-project-reference]'); if (addReferenceButton) addProjectReference();
  const selectedReference = event.target.closest('[data-pick-detail-reference]');
  if (selectedReference) { const reference = state.references.find(item => item.id === selectedReference.dataset.pickDetailReference); if (reference) addProjectReference(reference.label); }
  const removedReference = event.target.closest('[data-remove-project-reference]');
  if (removedReference) removeProjectReference(removedReference.dataset.removeProjectReference);
});
$('#detail-content').addEventListener('focusin', event => { if (event.target.id === 'detail-reference-input') openDetailReferencePicker(); });
$('#detail-content').addEventListener('input', event => { if (event.target.id === 'detail-reference-input') openDetailReferencePicker(); });
$('#detail-content').addEventListener('keydown', event => { if (event.target.id === 'detail-reference-input' && event.key === 'Enter') { event.preventDefault(); addProjectReference(); } if (event.target.id === 'detail-reference-input' && event.key === 'Escape') closePickers(); });
$('#new-project').addEventListener('click', () => showProjectModal()); $('#empty-create').addEventListener('click', () => showProjectModal());
$('#nav-overview').addEventListener('click', () => showPage('overview'));
$('#nav-all').addEventListener('click', () => { $('#search').value = ''; $('#status-filter').value = 'all'; $('#decision-filter').value = 'all'; state.quickFilter = null; showPage('projects'); });
$('#go-all').addEventListener('click', () => { $('#search').value = ''; $('#status-filter').value = 'all'; $('#decision-filter').value = 'all'; state.quickFilter = null; showPage('projects'); });
$$('[data-quick-filter]').forEach(button => button.addEventListener('click', () => {
  const filter = button.dataset.quickFilter; state.quickFilter = filter; $('#status-filter').value = filter === 'in_progress' || filter === 'finished' ? filter : 'all'; $('#decision-filter').value = filter === 'won' ? 'won' : 'all'; showPage('projects');
}));
$('#calendar-previous').addEventListener('click', () => { state.calendarOffset--; renderCalendar(); });
$('#calendar-next').addEventListener('click', () => { state.calendarOffset++; renderCalendar(); });
$('#calendar-today').addEventListener('click', () => { state.calendarOffset = 0; renderCalendar(); });
$('#search').addEventListener('input', renderProjectGrid);
$('#status-filter').addEventListener('change', () => { state.quickFilter = null; showPage('projects'); });
$('#decision-filter').addEventListener('change', () => { state.quickFilter = null; showPage('projects'); });
$('#reset-filters').addEventListener('click', () => { $('#search').value = ''; $('#status-filter').value = 'all'; $('#decision-filter').value = 'all'; state.quickFilter = null; showPage('projects'); });
$$('[data-add-person]').forEach(button => button.addEventListener('click', () => addPerson(button.dataset.addPerson)));
$$('[data-add-token="references"]').forEach(button => button.addEventListener('click', () => addReference()));
Object.keys(roleDom).forEach(role => {
  const input = personInput(role); input.addEventListener('focus', () => openPersonPicker(role)); input.addEventListener('click', () => openPersonPicker(role)); input.addEventListener('input', () => openPersonPicker(role));
  input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); addPerson(role); } if (event.key === 'Escape') closePickers(); });
});
$('#references-input').addEventListener('focus', openReferencePicker); $('#references-input').addEventListener('click', openReferencePicker); $('#references-input').addEventListener('input', openReferencePicker);
$('#references-input').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); addReference(); } if (event.key === 'Escape') closePickers(); });

document.addEventListener('click', async event => {
  const close = event.target.closest('[data-close]'); if (close) { document.getElementById(close.dataset.close).close(); return; }
  const removePerson = event.target.closest('[data-remove-person]');
  if (removePerson) { state.selectedPeople[removePerson.dataset.removePerson].splice(Number(removePerson.dataset.index), 1); renderTokens(); renderPeoplePicker(removePerson.dataset.removePerson); return; }
  const removeToken = event.target.closest('[data-remove-token]');
  if (removeToken) { state.selectedReferences.splice(Number(removeToken.dataset.index), 1); renderTokens(); renderReferencePicker(); return; }
  const removeUnclassified = event.target.closest('[data-remove-unclassified]');
  if (removeUnclassified) { state.selectedUnclassified.splice(Number(removeUnclassified.dataset.removeUnclassified), 1); renderTokens(); return; }
  const pickPerson = event.target.closest('[data-pick-person]');
  if (pickPerson) { const role = pickPerson.dataset.pickPerson; const person = state.people.find(entry => entry.id === pickPerson.dataset.personId); if (person) addPerson(role, person.name); return; }
  const pickReference = event.target.closest('[data-pick-reference]');
  if (pickReference) { const reference = state.references.find(entry => entry.id === pickReference.dataset.pickReference); if (reference) addReference(reference.label); return; }
  const libraryDelete = event.target.closest('[data-delete-library]');
  if (libraryDelete) { event.stopPropagation(); await deleteLibraryItem(libraryDelete.dataset.deleteLibrary, libraryDelete.dataset.libraryId, libraryDelete.dataset.libraryName, libraryDelete.dataset.projectCount, libraryDelete.dataset.libraryRole); return; }
  if (!event.target.closest('.picker-wrap')) closePickers();
  const edit = event.target.closest('[data-edit]');
  if (edit) { event.stopPropagation(); showProjectModal(state.projects.find(p => p.id === edit.dataset.edit)); return; }
  const detailEdit = event.target.closest('[data-detail-edit]');
  if (detailEdit) { const project = state.projects.find(p => p.id === detailEdit.dataset.detailEdit); $('#detail-modal').close(); showProjectModal(project); return; }
  const restart = event.target.closest('[data-restart]'); if (restart) { await restartWorkflow(restart.dataset.restart); return; }
  const del = event.target.closest('[data-delete]'); if (del) { await deleteProject(del.dataset.delete); return; }
  const note = event.target.closest('[data-open-notes]'); if (note) { event.stopPropagation(); await openDetail(note.dataset.openNotes); return; }
  const projectLink = event.target.closest('[data-open-project]'); if (projectLink) { await openDetail(projectLink.dataset.openProject); return; }
  const card = event.target.closest('[data-project]'); if (card) await openDetail(card.dataset.project);
});

document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'k') { event.preventDefault(); showPage('projects'); $('#search').focus(); }
  if (event.key === 'Enter' && event.target.matches('.project-card')) openDetail(event.target.dataset.project);
});
$('#project-modal').addEventListener('click', event => { if (event.target === $('#project-modal')) $('#project-modal').close(); });
$('#detail-modal').addEventListener('click', event => { if (event.target === $('#detail-modal')) $('#detail-modal').close(); });

setToday();
refresh().catch(error => {
  $('#project-grid').innerHTML = ''; $('#empty-state').classList.remove('hidden'); $('.empty-state h3').textContent = 'Impossible de charger vos projets';
  $('.empty-state p').textContent = 'Fermez puis relancez l’application. Si le problème persiste, demandez de l’aide à votre référent informatique.'; $('#empty-create').classList.add('hidden');
  $('#week-calendar').innerHTML = '<div class="overview-empty">Impossible de charger les projets. Fermez puis relancez l’application.</div>'; console.error(error);
});
