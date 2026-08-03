// Control Plane page fragment: Projects view (memory section, projects tab).
// Lists project identities (projectId/name/aliases/createdAt) and offers the
// "merge current workspace into this project" migration action (mailbox task 4).
// Same fragment contract as the other ./pages/*: safe DOM construction only
// (no innerHTML), i18n through the shared tr() helper, `proj-` class prefix.

export const PROJECTS_VIEW_HTML = `  <section id="projectsView" class="view" role="tabpanel" hidden>
    <div class="proj-toolbar">
      <p class="proj-intro" data-i18n="projects.intro">Projects group one or more workspaces under a shared board.</p>
      <button id="refreshProjects" class="secondary" type="button" data-i18n="common.refresh">Refresh</button>
      <span id="projectsCount" class="result-count" role="status"></span>
    </div>
    <div class="proj-create">
      <input id="newProjectName" type="text" data-i18n-placeholder="projects.namePlaceholder" placeholder="Project name (optional)" maxlength="80">
      <button id="createProject" class="primary" type="button" data-i18n="projects.create">New project + merge current workspace</button>
    </div>
    <div id="projectsList" class="proj-list"></div>
  </section>
`;

export const PROJECTS_PAGE_JS = `  function renderProjectCard(project) {
    var card = document.createElement('article');
    card.className = 'proj-card';
    var head = document.createElement('div');
    head.className = 'proj-head';
    var name = document.createElement('h3');
    name.className = 'proj-name proj-name-edit';
    name.textContent = project.name || project.projectId;
    name.title = tr('projects.renameTitle');
    name.setAttribute('role', 'button');
    name.addEventListener('click', function () { openProjectRename(project, card, name); });
    head.appendChild(name);
    var id = document.createElement('span');
    id.className = 'proj-id';
    id.textContent = project.projectId;
    head.appendChild(id);
    card.appendChild(head);
    var meta = document.createElement('div');
    meta.className = 'proj-meta';
    meta.textContent = tr('projects.createdAt', { createdAt: project.createdAt || '—' });
    card.appendChild(meta);
    var aliases = document.createElement('div');
    aliases.className = 'proj-aliases';
    var aliasesLabel = document.createElement('span');
    aliasesLabel.className = 'proj-aliases-label';
    aliasesLabel.textContent = tr('projects.aliases');
    aliases.appendChild(aliasesLabel);
    var aliasList = project.aliases || [];
    if (!aliasList.length) {
      var none = document.createElement('span');
      none.className = 'tag';
      none.textContent = tr('projects.noAliases');
      aliases.appendChild(none);
    }
    aliasList.forEach(function (alias) {
      var chip = document.createElement('span');
      chip.className = 'tag proj-alias';
      var aliasHash = document.createElement('span');
      aliasHash.className = 'proj-alias-hash';
      aliasHash.textContent = alias;
      chip.appendChild(aliasHash);
      var detach = document.createElement('button');
      detach.className = 'proj-alias-detach';
      detach.type = 'button';
      detach.textContent = '×';
      detach.title = tr('projects.detachAliasTitle');
      detach.setAttribute('aria-label', tr('projects.detachAliasTitle') + ' ' + alias);
      detach.addEventListener('click', function () { detachProjectAliasAction(project, alias); });
      chip.appendChild(detach);
      aliases.appendChild(chip);
    });
    card.appendChild(aliases);
    var actions = document.createElement('div');
    actions.className = 'proj-actions';
    var merge = document.createElement('button');
    merge.className = 'primary';
    merge.type = 'button';
    merge.textContent = tr('projects.merge');
    merge.addEventListener('click', function () { migrateCurrentWorkspace(project); });
    actions.appendChild(merge);
    var archive = document.createElement('button');
    archive.className = 'danger';
    archive.type = 'button';
    archive.textContent = tr('projects.archiveProject');
    archive.title = tr('projects.archiveTitle');
    archive.addEventListener('click', function () { archiveProjectAction(project); });
    actions.appendChild(archive);
    card.appendChild(actions);
    return card;
  }
  function openProjectRename(project, card, nameEl) {
    if (card.querySelector('.proj-rename')) return; // one inline editor per card
    var form = document.createElement('span');
    form.className = 'proj-rename';
    var input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 80;
    input.value = project.name || '';
    input.placeholder = tr('projects.renamePlaceholder');
    input.setAttribute('data-i18n-placeholder', 'projects.renamePlaceholder');
    var save = document.createElement('button');
    save.className = 'primary';
    save.type = 'button';
    save.textContent = tr('projects.renameSave');
    var cancel = document.createElement('button');
    cancel.className = 'secondary';
    cancel.type = 'button';
    cancel.textContent = tr('common.cancel');
    function closeEditor() {
      if (form.parentNode) form.parentNode.removeChild(form);
      nameEl.hidden = false;
    }
    function saveRename() {
      var value = input.value.trim();
      if (!value) { setNotice(tr('projects.renameRequired'), true); return; }
      api('/api/projects/' + encodeURIComponent(project.projectId), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: value })
      }).then(function () {
        setNotice(tr('projects.renamed'), false);
        return loadProjects().then(function () { return loadWorkspaces().catch(function () {}); });
      }).catch(function (error) { setNotice(error.message, true); });
    }
    save.addEventListener('click', saveRename);
    cancel.addEventListener('click', closeEditor);
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') { event.preventDefault(); saveRename(); }
      else if (event.key === 'Escape') closeEditor();
    });
    form.appendChild(input);
    form.appendChild(save);
    form.appendChild(cancel);
    nameEl.hidden = true;
    nameEl.parentNode.insertBefore(form, nameEl);
    input.focus();
  }
  function detachProjectAliasAction(project, alias) {
    var label = project.name || project.projectId;
    if (!window.confirm(tr('projects.detachConfirm', { alias: alias, project: label }))) return;
    api('/api/projects/' + encodeURIComponent(project.projectId) + '/aliases/' + encodeURIComponent(alias), { method: 'DELETE' }).then(function () {
      setNotice(tr('projects.detached'), false);
      return loadProjects().then(function () { return loadWorkspaces().catch(function () {}); });
    }).catch(function (error) { setNotice(error.message, true); });
  }
  function archiveProjectAction(project) {
    var label = project.name || project.projectId;
    if (!window.confirm(tr('projects.archiveConfirm', { project: label }))) return;
    api('/api/projects/' + encodeURIComponent(project.projectId) + '/archive', { method: 'POST' }).then(function () {
      setNotice(tr('projects.archived'), false);
      return loadProjects().then(function () { return loadWorkspaces().catch(function () {}); });
    }).catch(function (error) { setNotice(error.message, true); });
  }
  function renderProjects(projects) {
    var list = document.getElementById('projectsList');
    list.textContent = '';
    if (!projects.length) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = tr('projects.empty');
      list.appendChild(empty);
      return;
    }
    projects.forEach(function (project) { list.appendChild(renderProjectCard(project)); });
  }
  function loadProjects() {
    if (!currentWorkspace) return Promise.resolve();
    return api('/api/projects').then(function (data) {
      var projects = data && Array.isArray(data.projects) ? data.projects : [];
      renderProjects(projects);
      document.getElementById('projectsCount').textContent = tr(projects.length === 1 ? 'projects.count' : 'projects.countPlural', { count: projects.length });
    });
  }
  function migrateCurrentWorkspace(project) {
    if (!currentWorkspace) return;
    var label = project.name || project.projectId;
    if (!window.confirm(tr('projects.mergeConfirm', { project: label }))) return;
    api('/api/projects/migrate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace: currentWorkspace, projectId: project.projectId }) }).then(function (result) {
      setNotice(tr('projects.merged', { projectId: result.projectId, moved: result.moved }), false);
      return loadProjects().then(function () {
        // The migrated workspace sidecar is archived, so the workspace list
        // must be re-read (applyWorkspace then picks the next workspace).
        return loadWorkspaces().catch(function () {});
      });
    }).catch(function (error) { setNotice(error.message, true); });
  }
  function createProjectFromCurrentWorkspace() {
    if (!currentWorkspace) return;
    var nameInput = document.getElementById('newProjectName');
    var name = nameInput.value.trim();
    var label = name || tr('projects.untitled');
    if (!window.confirm(tr('projects.createConfirm', { project: label }))) return;
    var payload = { workspace: currentWorkspace };
    if (name) payload.name = name;
    api('/api/projects/migrate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }).then(function (result) {
      nameInput.value = '';
      setNotice(tr('projects.merged', { projectId: result.projectId, moved: result.moved }), false);
      return loadProjects().then(function () {
        return loadWorkspaces().catch(function () {});
      });
    }).catch(function (error) { setNotice(error.message, true); });
  }
`;
