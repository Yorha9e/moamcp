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
    <div id="projectsList" class="proj-list"></div>
  </section>
`;

export const PROJECTS_PAGE_JS = `  function renderProjectCard(project) {
    var card = document.createElement('article');
    card.className = 'proj-card';
    var head = document.createElement('div');
    head.className = 'proj-head';
    var name = document.createElement('h3');
    name.className = 'proj-name';
    name.textContent = project.name || project.projectId;
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
      chip.textContent = alias;
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
    card.appendChild(actions);
    return card;
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
`;
