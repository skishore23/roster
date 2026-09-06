import type { WorkspaceNodeSocialParticipant } from "../engine/workspace/node.js";
import { esc } from "./agent-framework.js";

export type ParticipantContinuitySeed = {
  readonly status: "dormant" | "queued" | "working" | "waiting" | "suspended";
  readonly pendingItemCount: number;
  readonly pendingLaneCount: number;
  readonly activeCommitmentCount: number;
  readonly activeRoomLabel?: string;
  readonly memoryUpdatedAt?: number;
  readonly lanes?: ReadonlyArray<{
    readonly laneId: string;
    readonly roomLabel: string;
    readonly pendingItemCount: number;
    readonly active: boolean;
  }>;
};

type ParticipantProfileSeed = Pick<
  WorkspaceNodeSocialParticipant,
  "nodeId" | "displayName" | "role" | "kind" | "summary"
> & {
  readonly bio?: string;
  readonly skills?: ReadonlyArray<string>;
  readonly capabilities?: ReadonlyArray<string>;
  /** Replaceable execution facts, kept separate from the participant identity. */
  readonly agent?: string;
  readonly model?: string;
  readonly executionScope?: "message" | "active" | "preference";
  /** Safe scheduling projection; never contains inbox bodies or memory text. */
  readonly continuity?: ParticipantContinuitySeed;
};

export const participantProfileAttributes = (participant: ParticipantProfileSeed): string => [
  `data-participant-profile="${esc(participant.nodeId)}"`,
  `data-profile-name="${esc(participant.displayName)}"`,
  `data-profile-role="${esc(participant.role)}"`,
  `data-profile-kind="${esc(participant.kind)}"`,
  `data-profile-bio="${esc(participant.bio ?? participant.summary ?? "")}"`,
  `data-profile-skills="${esc(JSON.stringify(participant.skills ?? []))}"`,
  `data-profile-capabilities="${esc(JSON.stringify(participant.capabilities ?? []))}"`,
  ...(participant.agent ? [`data-profile-agent="${esc(participant.agent)}"`] : []),
  ...(participant.model ? [`data-profile-model="${esc(participant.model)}"`] : []),
  ...(participant.executionScope ? [`data-profile-execution-scope="${esc(participant.executionScope)}"`] : []),
  ...(participant.continuity ? [`data-profile-continuity="${esc(JSON.stringify(participant.continuity))}"`] : []),
  `aria-haspopup="dialog"`,
  `aria-controls="participant-profile-dialog"`,
].join(" ");

export const participantMentionHtml = (input: ParticipantProfileSeed): string =>
  `<button type="button" class="participant-mention" ${participantProfileAttributes(input)} title="Open ${esc(input.displayName)}’s profile">@${esc(input.displayName)}</button>`;

export const participantProfileDialogHtml = (options?: {
  readonly editable?: boolean;
  readonly runtimeEditorHtml?: string;
}): string => `<dialog class="participant-profile-dialog" id="participant-profile-dialog" data-participant-profile-dialog aria-labelledby="participant-profile-title">
  <div class="participant-profile-shell">
    <header class="participant-profile-head">
      <span class="participant-profile-avatar" data-participant-profile-avatar aria-hidden="true">R</span>
      <span><small data-participant-profile-kind>Agent profile</small><h2 id="participant-profile-title" data-participant-profile-title tabindex="-1">Participant</h2><p data-participant-profile-role>Workspace participant</p></span>
      <form method="dialog"><button type="submit" class="participant-profile-close" aria-label="Close participant profile">×</button></form>
    </header>
    <p class="participant-profile-bio" data-participant-profile-bio>No bio yet.</p>
    <section class="participant-profile-execution" data-participant-profile-execution aria-labelledby="participant-profile-execution-title" hidden>
      <header><span><small data-participant-profile-execution-scope>Future work</small><h3 id="participant-profile-execution-title">Agent &amp; model</h3></span></header>
      <dl><div><dt>Agent</dt><dd data-participant-profile-agent></dd></div><div><dt>Model</dt><dd data-participant-profile-model></dd></div></dl>
      <p>Execution can change without changing this participant or their room history.</p>
    </section>
    <section class="participant-profile-continuity" data-participant-profile-continuity aria-labelledby="participant-profile-continuity-title" hidden>
      <header><span><small>Workspace continuity</small><h3 id="participant-profile-continuity-title">Current activity</h3></span><strong data-participant-profile-continuity-status></strong></header>
      <dl><div><dt>Now</dt><dd data-participant-profile-active-room></dd></div><div><dt>Queue</dt><dd data-participant-profile-inbox-count></dd></div><div><dt>Open work</dt><dd data-participant-profile-commitment-count></dd></div><div><dt>Private memory</dt><dd data-participant-profile-memory-state></dd></div></dl>
      <div data-participant-profile-lanes hidden><h4>Room queue</h4><ol data-participant-profile-lane-list></ol></div>
      <p>Only scheduling state is shown. Inbox contents and private memory remain private.</p>
    </section>
    <section class="participant-profile-facts" aria-label="Profile skills and capabilities">
      <div><h3>Skills</h3><ul data-participant-profile-skills><li>None added yet</li></ul></div>
      <div><h3>Capabilities</h3><ul data-participant-profile-capabilities><li>None added yet</li></ul></div>
    </section>
    ${options?.runtimeEditorHtml ?? ""}
    ${options?.editable === false ? "" : `<details class="participant-profile-editor" data-participant-profile-editor>
      <summary>Customize profile</summary>
      <form data-participant-profile-form>
        <input type="hidden" name="nodeId"/>
        <input type="hidden" name="revision" value="0"/>
        <label><span>Name</span><input name="displayName" maxlength="80" autocomplete="off" required/></label>
        <label><span>Role</span><input name="role" maxlength="120" autocomplete="off" required/></label>
        <label><span>Bio</span><textarea name="bio" maxlength="1000" rows="3" placeholder="What should teammates know?"></textarea></label>
        <label><span>Skills</span><input name="skills" maxlength="3900" autocomplete="off" placeholder="React, accessibility, API design"/><small>Comma-separated. These become part of future task context.</small></label>
        <label><span>Capabilities</span><input name="capabilities" maxlength="3900" autocomplete="off" placeholder="implement, review, validate"/><small>Comma-separated task capabilities. Changes apply to future runs.</small></label>
        <footer><p data-participant-profile-status role="status" aria-live="polite"></p><button type="submit">Save profile</button></footer>
      </form>
    </details>`}
  </div>
</dialog>`;

export const participantProfileViewClientSource = `(()=>{
  const dialog=document.querySelector('[data-participant-profile-dialog]');
  if(!(dialog instanceof HTMLDialogElement))return;
  let returnFocus=null;
  const values=(encoded)=>{try{const parsed=JSON.parse(encoded||'[]');return Array.isArray(parsed)?parsed.filter((value)=>typeof value==='string'):[];}catch{return [];}};
  const renderList=(selector,items)=>{const list=dialog.querySelector(selector);if(!list)return;list.replaceChildren();for(const value of items.length?items:['None added yet']){const item=document.createElement('li');item.textContent=value;list.append(item);}};
  const renderExecution=(trigger)=>{const agent=trigger.dataset.profileAgent||'';const model=trigger.dataset.profileModel||'';const section=dialog.querySelector('[data-participant-profile-execution]');if(!(section instanceof HTMLElement))return;section.hidden=!agent&&!model;const agentValue=dialog.querySelector('[data-participant-profile-agent]');const modelValue=dialog.querySelector('[data-participant-profile-model]');const scope=dialog.querySelector('[data-participant-profile-execution-scope]');if(agentValue)agentValue.textContent=agent||'Not recorded';if(modelValue)modelValue.textContent=model||'Not recorded';if(scope)scope.textContent=trigger.dataset.profileExecutionScope==='message'?'This message':trigger.dataset.profileExecutionScope==='active'?'Active run':'Future work';};
  const renderContinuity=(trigger)=>{const section=dialog.querySelector('[data-participant-profile-continuity]');if(!(section instanceof HTMLElement))return;let value=null;try{value=JSON.parse(trigger.dataset.profileContinuity||'null');}catch{}section.hidden=!value;if(!value)return;section.dataset.state=value.status||'dormant';const set=(selector,text)=>{const target=dialog.querySelector(selector);if(target)target.textContent=text;};const itemCount=Number.isFinite(value.pendingItemCount)?value.pendingItemCount:0;const roomCount=Number.isFinite(value.pendingLaneCount)?value.pendingLaneCount:0;const commitmentCount=Number.isFinite(value.activeCommitmentCount)?value.activeCommitmentCount:0;set('[data-participant-profile-continuity-status]',value.status==='working'?'Working now':value.status==='queued'?'Starting':value.status==='waiting'?'Queued':value.status==='suspended'?'Paused':'Available');set('[data-participant-profile-active-room]',value.activeRoomLabel||'No active room');set('[data-participant-profile-inbox-count]',itemCount+' item'+(itemCount===1?'':'s')+' across '+roomCount+' room'+(roomCount===1?'':'s'));set('[data-participant-profile-commitment-count]',commitmentCount+' open');const memoryDate=Number.isFinite(value.memoryUpdatedAt)?new Date(value.memoryUpdatedAt):null;set('[data-participant-profile-memory-state]',memoryDate?'Updated '+new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(memoryDate):'Not saved yet');const lanes=Array.isArray(value.lanes)?value.lanes:[];const wrap=dialog.querySelector('[data-participant-profile-lanes]');const list=dialog.querySelector('[data-participant-profile-lane-list]');if(wrap instanceof HTMLElement)wrap.hidden=!lanes.length;if(list){list.replaceChildren();for(const lane of lanes.slice(0,6)){const item=document.createElement('li');const label=document.createElement('span');const count=document.createElement('small');label.textContent=lane.roomLabel||'Room';label.title=label.textContent;count.textContent=lane.active?'Working now':lane.pendingItemCount+' waiting';item.dataset.state=lane.active?'active':'waiting';item.append(label,count);list.append(item);}}};
  document.addEventListener('click',(event)=>{
    const trigger=event.target instanceof Element?event.target.closest('[data-participant-profile]'):null;
    if(!(trigger instanceof HTMLElement))return;
    returnFocus=trigger;
    const name=trigger.dataset.profileName||trigger.textContent?.replace(/^@/,'').trim()||'Participant';
    const role=trigger.dataset.profileRole||'Workspace participant';
    const bio=trigger.dataset.profileBio||'No bio yet.';
    const title=dialog.querySelector('[data-participant-profile-title]');
    const roleText=dialog.querySelector('[data-participant-profile-role]');
    const bioText=dialog.querySelector('[data-participant-profile-bio]');
    const kind=dialog.querySelector('[data-participant-profile-kind]');
    const avatar=dialog.querySelector('[data-participant-profile-avatar]');
    if(title)title.textContent=name;if(roleText)roleText.textContent=role;if(bioText)bioText.textContent=bio;
    if(kind)kind.textContent=(trigger.dataset.profileKind||'participant')+' profile';if(avatar)avatar.textContent=(name[0]||'?').toUpperCase();
    renderList('[data-participant-profile-skills]',values(trigger.dataset.profileSkills));
    renderList('[data-participant-profile-capabilities]',values(trigger.dataset.profileCapabilities));
    renderExecution(trigger);
    renderContinuity(trigger);
    if(!dialog.open)dialog.showModal();if(title instanceof HTMLElement)title.focus();
  });
  dialog.addEventListener('click',(event)=>{if(event.target===dialog)dialog.close();});
  dialog.addEventListener('close',()=>{if(returnFocus instanceof HTMLElement)returnFocus.focus({preventScroll:true});returnFocus=null;});
})();`;

export const participantProfileCss = (): string => `
  .participant-profile-trigger,.participant-mention{padding:0;border:0;color:inherit;background:transparent;cursor:pointer;font:inherit}.participant-profile-trigger:hover,.participant-profile-trigger:focus-visible,.participant-mention:hover,.participant-mention:focus-visible{color:var(--accent-strong,var(--accent));text-decoration:underline;text-decoration-color:var(--accent,var(--accent-strong));text-underline-offset:3px}.participant-profile-trigger:focus-visible,.participant-mention:focus-visible{outline:2px solid var(--focus-ring,var(--accent));outline-offset:2px;border-radius:3px}.participant-mention{color:var(--accent-strong,var(--accent));font-family:var(--font-mono,ui-monospace,monospace);font-size:inherit;font-weight:650;white-space:nowrap}
  .participant-profile-dialog{width:min(560px,calc(100vw - 28px));max-height:min(760px,calc(100dvh - 28px));padding:0;overscroll-behavior:contain;border:1px solid var(--border-strong);border-radius:var(--radius-overlay);color:var(--text-primary);background:var(--surface-overlay);box-shadow:var(--shadow-overlay)}.participant-profile-dialog::backdrop{background:rgba(0,0,0,.68);backdrop-filter:blur(3px)}.participant-profile-shell{display:grid;gap:15px;max-height:inherit;overflow:auto;padding:18px}.participant-profile-head{display:grid;grid-template-columns:44px minmax(0,1fr) 34px;gap:11px;align-items:center}.participant-profile-avatar{width:44px;height:44px;display:grid;place-items:center;border:1px solid var(--border-strong);border-radius:12px;color:var(--accent-strong);background:var(--surface-raised);font-size:15px;font-weight:800}.participant-profile-head>span:nth-child(2){min-width:0}.participant-profile-head small,.participant-profile-head h2,.participant-profile-head p{display:block;margin:0}.participant-profile-head small{color:var(--text-tertiary);font:750 9px/1.2 var(--font-mono,ui-monospace,monospace);text-transform:uppercase;letter-spacing:.08em}.participant-profile-head h2{margin-top:4px;font-size:20px;line-height:1.2;text-wrap:balance}.participant-profile-head h2:focus-visible{outline:1px solid color-mix(in srgb,var(--focus-ring,var(--accent)) 38%,transparent);outline-offset:3px;border-radius:3px}.participant-profile-head p{margin-top:3px;color:var(--text-secondary);font-size:11px}.participant-profile-close{width:34px;height:34px;border:1px solid var(--border-subtle);border-radius:var(--radius-control);color:var(--text-secondary);background:var(--surface-raised);cursor:pointer;font-size:17px}.participant-profile-close:hover{color:var(--text-primary);background:var(--surface-hover)}.participant-profile-close:focus-visible{outline:2px solid var(--focus-ring,var(--accent));outline-offset:2px}.participant-profile-bio{margin:0;color:var(--text-secondary);font-size:12px;line-height:1.55;text-wrap:pretty}.participant-profile-execution,.participant-profile-continuity{display:grid;gap:9px;padding:11px;border:1px solid color-mix(in srgb,var(--accent-strong) 32%,var(--border-subtle));border-radius:var(--radius-card);background:color-mix(in srgb,var(--accent-strong) 5%,var(--surface-inset))}.participant-profile-execution[hidden],.participant-profile-continuity[hidden]{display:none}.participant-profile-execution header small,.participant-profile-execution header h3,.participant-profile-continuity header small,.participant-profile-continuity header h3{display:block;margin:0}.participant-profile-execution header small,.participant-profile-continuity header small{color:var(--accent-strong);font:750 9px/1.2 var(--font-mono,ui-monospace,monospace);text-transform:uppercase;letter-spacing:.08em}.participant-profile-execution header h3,.participant-profile-continuity header h3{margin-top:3px;font-size:13px}.participant-profile-execution dl,.participant-profile-continuity dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;margin:0}.participant-profile-execution dl>div,.participant-profile-continuity dl>div{min-width:0;padding:8px;border:1px solid var(--border-subtle);border-radius:var(--radius-control);background:var(--surface-raised)}.participant-profile-execution dt,.participant-profile-continuity dt{color:var(--text-tertiary);font-size:9px}.participant-profile-execution dd,.participant-profile-continuity dd{margin:3px 0 0;overflow:hidden;color:var(--text-primary);font-size:11px;font-weight:700;text-overflow:ellipsis;white-space:nowrap}.participant-profile-execution>p,.participant-profile-continuity>p{margin:0;color:var(--text-tertiary);font-size:9px;line-height:1.45}.participant-profile-continuity>header{display:flex;align-items:start;justify-content:space-between;gap:10px}.participant-profile-continuity>header>strong{padding:4px 7px;border-radius:999px;color:var(--accent-strong);background:var(--surface-raised);font-size:9px}.participant-profile-continuity[data-state="working"]>header>strong{color:var(--success)}.participant-profile-continuity[data-state="suspended"]>header>strong{color:var(--warning)}.participant-profile-continuity h4{margin:2px 0 6px;color:var(--text-tertiary);font-size:9px;text-transform:uppercase;letter-spacing:.06em}.participant-profile-continuity ol{display:grid;gap:4px;margin:0;padding:0;list-style:none}.participant-profile-continuity li{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 8px;border:1px solid var(--border-subtle);border-radius:var(--radius-control);background:var(--surface-raised)}.participant-profile-continuity li span{min-width:0;overflow:hidden;font-size:10px;text-overflow:ellipsis;white-space:nowrap}.participant-profile-continuity li small{color:var(--text-tertiary);font-size:9px;white-space:nowrap}.participant-profile-continuity li[data-state="active"] small{color:var(--success)}.participant-profile-facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.participant-profile-facts>div{min-width:0;padding:11px;border:1px solid var(--border-subtle);border-radius:var(--radius-card);background:var(--surface-inset)}.participant-profile-facts h3{margin:0 0 8px;color:var(--text-tertiary);font-size:9px;text-transform:uppercase;letter-spacing:.06em}.participant-profile-facts ul{display:flex;flex-wrap:wrap;gap:5px;margin:0;padding:0;list-style:none}.participant-profile-facts li{max-width:100%;overflow:hidden;padding:4px 7px;border:1px solid var(--border-subtle);border-radius:999px;color:var(--text-secondary);background:var(--surface-raised);font-size:9px;text-overflow:ellipsis;white-space:nowrap}.participant-profile-editor{border-top:1px solid var(--border-subtle);padding-top:12px}.participant-profile-editor>summary{width:max-content;color:var(--accent-strong);cursor:pointer;font-size:11px;font-weight:700}.participant-profile-editor>form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:13px}.participant-profile-editor label{min-width:0;display:grid;gap:5px}.participant-profile-editor label:nth-of-type(n+3){grid-column:1/-1}.participant-profile-editor label>span{color:var(--text-secondary);font-size:9px;font-weight:700}.participant-profile-editor input,.participant-profile-editor textarea,.participant-profile-editor select{width:100%;border:1px solid var(--border-strong);border-radius:var(--radius-control);padding:8px 9px;color:var(--text-primary);background:var(--surface-inset);font-size:11px;resize:vertical}.participant-profile-editor label small{color:var(--text-tertiary);font-size:8px;line-height:1.4}.participant-profile-editor footer{grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;gap:12px}.participant-profile-editor footer p{min-height:16px;margin:0;color:var(--text-tertiary);font-size:9px}.participant-profile-editor footer p[data-state="error"]{color:var(--danger)}.participant-profile-editor footer p[data-state="success"]{color:var(--success)}.participant-profile-editor button[type="submit"]{min-height:34px;padding:0 12px;border:1px solid var(--action-primary);border-radius:var(--radius-control);color:var(--action-primary-foreground);background:var(--action-primary);cursor:pointer;font-size:10px;font-weight:750}.participant-profile-editor button[type="submit"]:disabled{cursor:wait;opacity:.6}@media(max-width:560px){.participant-profile-facts,.participant-profile-execution dl,.participant-profile-continuity dl,.participant-profile-editor>form{grid-template-columns:1fr}.participant-profile-editor label{grid-column:1!important}}
`;
