/**
 * @anglea_lwh/dsh-archive-purge — browser half (hand-written lazy-CJS plugin bundle).
 *
 * Client bundles are plain artifacts: `dsh-client-modules` reads the file named
 * by `exports["./client"]` and serves it verbatim, so this file is what a build
 * step would have emitted — `window.__ModuleLoader__.load({ id, factory })`
 * whose factory body holds every side effect (CSS injection included) and runs
 * at materialization, never at script execution. The module `id` must equal the
 * `package.json` name, because that name is the boot-graph row the loader
 * materializes.
 *
 * Two extension points are used, both declared by `@deepseek-ai/dsh-client-ui-workspace`
 * and both given only the row identity (`sessionId`, `displayTitle`):
 * `sidebar.workspaces.session.menu.item` (the row's "..." menu, where the
 * shipped pin/rename/fork/archive rows live at orders 100–400) and
 * `sidebar.workspaces.session.row.action` (the hover strip, where archive is
 * order 100 and pin 200). A third registration opens the confirmation dialog in
 * the frame-wide `shell.overlay` seat.
 *
 * The archived test comes from the Host's own archive set, projected out of the
 * Workspace projection the shell already streams (`workspaces.list`), so this
 * plugin adds no polling and no second source of truth.
 */
window.__ModuleLoader__.load({
	id: '@anglea_lwh/dsh-archive-purge',
	factory: (require) => {
		const module = { exports: {} }
		const exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		const React = require('react')
		const { jsx, jsxs, Fragment } = require('react/jsx-runtime')
		const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
		const { createSnapshotStore } = require('@deepseek-ai/dsh-client-store')

		/** Locale namespace owned by this plugin. */
		const NS = 'archivePurge'
		/**
		 * Exact Host route served by this plugin's Host half. It lives under `/api`
		 * because that is the only seat whose owner admits the request, and it is
		 * addressed document-relatively like every other app-facing route in this
		 * shell (`<base href="./">`), matching `dsh-client-file-upload`.
		 */
		const ROUTE_PATH = '/api/archive-purge/deleteSession'
		/** Route verbs, mirroring the Host half's own action constants. */
		const ACTION_DELETE = 'delete'
		const ACTION_LIST_PENDING = 'listPending'
		const ACTION_RETRY_PENDING = 'retryPending'
		/** Both rows sit after the shipped archive action (menu 400 / hover 100). */
		const MENU_ORDER = 500
		const BUTTON_ORDER = 300
		/** The retry row follows the delete row in the same menu. */
		const RETRY_MENU_ORDER = 600
		const STYLE_MARKER = 'data-dsh-archive-purge'

		/**
		 * Visible copy, kept in this plugin's own namespace. Only the archived
		 * Session row shows these, so the row's own locale never has to change.
		 */
		const en = {
			'menu.deleteSession': 'Delete session',
			'actions.delete': 'Delete',
			'confirm.title': 'Permanently delete this session?',
			'confirm.desc': '\u201c{title}\u201d and its stored log will be removed from disk. This cannot be undone.',
			'confirm.pending': 'Deleting\u2026',
			'confirm.action': 'Delete permanently',
			'cancel': 'Cancel',
			'close': 'Close',
			'failed': 'Delete failed: {message}',
			'failed.deferred':
				'This session is still loaded by DeepSeek Harness, so it cannot be removed right now. It is now scheduled: the next DSH start removes it from disk automatically. Its history stays untouched until then, and unarchiving it cancels the pending removal.',
			'failed.loaded':
				'This session is still loaded by DeepSeek Harness, usually because it was just open. Its history is untouched. Deleting works once the Host has released it, which happens after a restart.',
			'failed.running': 'This session has work in progress. Stop it first, then delete.',
			'failed.notArchived': 'Only an archived session can be deleted. Archive it first.',
			'failed.subagent': 'This session was produced by a subagent and cannot be deleted.',
			'failed.guard': 'Refused for safety: the session directory did not pass its checks. Nothing was deleted.',
			'menu.retryPending': 'Finish pending deletions',
			'pending.title': 'Pending deletions',
			'pending.lead':
				'Sessions whose log could not be removed because the Host was still holding them. Unarchiving a session cancels its pending removal.',
			'pending.noStore': 'No Harness home could be resolved, so there is no deferred-purge store on this machine.',
			'pending.count': '{count} session(s) are waiting to be removed from disk.',
			'pending.none': 'Nothing is pending: every scheduled deletion has already completed.',
			'pending.loading': 'Reading the pending list\u2026',
			'pending.retry': 'Clean up now',
			'pending.running': 'Cleaning up\u2026',
			'pending.still':
				'{count} session(s) are still held in memory by the Host. Its history is untouched; this window can delete them the moment the Host releases them, so try again later \u2014 a restart is no longer required.',
			'pending.done': 'Removed {count} session(s) from disk.',
			'pending.drop': 'Dropped {count} entry that can no longer be purged (unarchived, or not deletable).',
			'pending.fail': 'Failed: {message}',
		}
		const zh = {
			'menu.deleteSession': '删除会话',
			'actions.delete': '删除',
			'confirm.title': '永久删除该会话？',
			'confirm.desc': '“{title}”及其日志将从磁盘移除，此操作无法撤销。',
			'confirm.pending': '正在删除…',
			'confirm.action': '永久删除',
			'cancel': '取消',
			'close': '关闭',
			'failed': '删除失败：{message}',
			'failed.deferred':
				'该会话仍被 DSH 宿主加载在内存中，此刻无法立即删除。已登记为待删除：下次启动 DSH 时会自动从磁盘移除。在此之前它的历史不会被改动；若改变主意，取消归档即可撤销。',
			'failed.loaded': '该会话仍被 DSH 宿主加载在内存中（通常是因为刚打开过它）。它的历史没有被动过。宿主重启释放该会话后，再点删除即可彻底移除。',
			'failed.running': '该会话有正在进行的工作，请先停止，然后再删除。',
			'failed.notArchived': '只有已归档的会话才能删除，请先归档。',
			'failed.subagent': '这是子代理产生的会话，不支持删除。',
			'failed.guard': '为安全起见已拒绝：会话目录未通过校验，未删除任何内容。',
			'menu.retryPending': '完成待删除清理',
			'pending.title': '待删除的清理',
			'pending.lead': '这些会话的日志因为仍被宿主占用而没能删除。取消归档即可撤销对应的待删除登记。',
			'pending.noStore': '无法确定 Harness 主目录，这台机器上不存在待删除登记文件。',
			'pending.count': '有 {count} 个会话等待从磁盘移除。',
			'pending.none': '当前没有待删除项：已登记的清理都已完成。',
			'pending.loading': '正在读取待删除列表\u2026',
			'pending.retry': '立即清理',
			'pending.running': '正在清理\u2026',
			'pending.still':
				'还有 {count} 个会话被宿主占用在内存中。它们的历史没有被改动；宿主一旦释放，在这里就能直接删除，稍后重试即可，不必再重启 DSH。',
			'pending.done': '已从磁盘移除 {count} 个会话。',
			'pending.drop': '已丢弃 {count} 条无法继续清理的登记（已取消归档，或本身不可删除）。',
			'pending.fail': '失败：{message}',
		}

		/**
		 * Refusal codes with their own localized explanation. A code the Host added
		 * later falls through to the generic line, so the dialog can never lose a
		 * reason entirely.
		 */
		const FAILURE_COPY = {
			'archive-purge/session-deferred': 'failed.deferred',
			'archive-purge/session-loaded': 'failed.loaded',
			'archive-purge/session-running': 'failed.running',
			'archive-purge/not-archived': 'failed.notArchived',
			'archive-purge/subagent': 'failed.subagent',
			'archive-purge/target-mismatch': 'failed.guard',
			'archive-purge/target-not-a-session': 'failed.guard',
			'archive-purge/not-found': 'failed.guard',
			'archive-purge/no-pending-store': 'pending.noStore',
		}

		// The row's hover strip styles its own 16px icon buttons from a private CSS
		// module, which a foreign plugin cannot reach, so the same geometry and
		// danger hover are declared here against the shared theme tokens.
		const CSS = [
			'.dsh-ap-icon{box-sizing:border-box;border-radius:var(--dsw-radius-xs);cursor:pointer;width:16px;height:16px;',
			'color:var(--dsw-alias-label-tertiary);background:0 0;border:none;flex:none;justify-content:center;align-items:center;',
			'padding:0;display:inline-flex}',
			'.dsh-ap-icon:hover{color:var(--dsw-alias-state-error-primary)}',
			'.dsh-ap-icon:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid ',
			'var(--dsw-focus-ring-color,var(--dsw-alias-state-error-primary));outline-offset:-2px}',
			'.dsh-ap-danger:not(:disabled){color:var(--dsw-alias-state-error-primary)}',
			'.dsh-ap-status{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
			'.dsh-ap-error{color:var(--dsw-alias-state-error-primary);margin-top:8px;font-size:12px;line-height:18px}',
		].join('')

		/**
		 * Install this plugin's styles once. Re-materialization (HMR) replaces the
		 * element instead of stacking a second copy.
		 * @param doc - the page document.
		 */
		function installStyles(doc) {
			try {
				for (const stale of doc.querySelectorAll(`style[${STYLE_MARKER}]`)) stale.remove()
				const element = doc.createElement('style')
				element.setAttribute(STYLE_MARKER, '')
				element.textContent = CSS
				doc.head.append(element)
			} catch {
				// A missing document head costs styling, never the feature.
			}
		}

		/**
		 * Project one observable into another, recomputing only when the source
		 * snapshot changes identity so a per-row `Set` lookup never rebuilds it on
		 * every read.
		 * @param source - the observable to project.
		 * @param project - pure projection of one source snapshot.
		 * @returns the projected observable, subscribing through the source.
		 */
		function derive(source, project) {
			let seen
			let value
			return {
				getSnapshot: () => {
					const snapshot = source.getSnapshot()
					if (value === undefined || snapshot !== seen) {
						seen = snapshot
						value = project(snapshot)
					}
					return value
				},
				subscribe: (listener) => source.subscribe(listener),
			}
		}

		/** Menu row: an archived Session's only destructive action. */
		function DeleteSessionMenuItem({ sessionId, displayTitle, useArchived, useMenuOpenState, requestDelete, t }) {
			const [, setMenuOpen] = useMenuOpenState()
			const archived = useArchived((set) => set.has(sessionId))
			if (archived !== true) return null
			return jsx(primitives.MenuItemButton, {
				separatorBefore: true,
				danger: true,
				icon: jsx(primitives.IconTrashOutlineRegular, { size: 14 }),
				onSelect: () => {
					setMenuOpen(false)
					requestDelete(sessionId, displayTitle)
				},
				children: t('menu.deleteSession'),
			})
		}

		/** Hover button: the same action without opening the menu. */
		function DeleteSessionRowButton({ sessionId, displayTitle, useArchived, requestDelete, t }) {
			const archived = useArchived((set) => set.has(sessionId))
			if (archived !== true) return null
			return jsx(primitives.Tooltip, {
				label: t('actions.delete'),
				side: 'bottom',
				align: 'end',
				delayMs: 500,
				children: jsx('button', {
					type: 'button',
					className: 'dsh-ap-icon',
					'aria-label': t('menu.deleteSession'),
					onClick: () => {
						requestDelete(sessionId, displayTitle)
					},
					children: jsx(primitives.IconTrashOutlineRegular, { size: 14 }),
				}),
			})
		}

		/**
		 * Menu row for the deferred purges: the seat that replaces a Host restart.
		 *
		 * It is deliberately not destructive and needs no archived Session of its own —
		 * the pending set is global, and unarchiving a Session is what cancels its
		 * entry. It sits in the row menu so it is reachable from the same place the row
		 * actions are.
		 */
		function RetryPendingMenuItem({ useMenuOpenState, requestRetry, t }) {
			const [, setMenuOpen] = useMenuOpenState()
			return jsx(primitives.MenuItemButton, {
				separatorBefore: true,
				icon: jsx(primitives.IconRefreshOutlineRegular, { size: 14 }),
				onSelect: () => {
					setMenuOpen(false)
					requestRetry()
				},
				children: t('menu.retryPending'),
			})
		}

		/** The retry dialog, and the only seat that shows the pending set to a user. */
		function PendingPurgeDialog({ useRetryRequest, settleRetryRequest, listPending, retryPending, t }) {
			const request = useRetryRequest((pending) => pending)
			if (request === null) return null
			return jsx(PendingPurgeConfirm, { request, settleRetryRequest, listPending, retryPending, t })
		}

		/**
		 * One dialog lifetime: the staged set is read when it opens, and the pass runs
		 * only on request. An entry the Host still holds stays staged and is reported
		 * as such, so the dialog's answer is never a promise the Host cannot keep.
		 */
		function PendingPurgeConfirm({ request, settleRetryRequest, listPending, retryPending, t }) {
			const [state, setState] = React.useState({ phase: 'reading', value: null, error: null, result: null })

			React.useEffect(() => {
				let live = true
				listPending().then(
					(value) => {
						if (live) setState((previous) => ({ ...previous, phase: 'ready', value }))
					},
					(reason) => {
						if (live) setState((previous) => ({ ...previous, phase: 'ready', error: describeFailure(reason, t) }))
					},
				)
				return () => {
					live = false
				}
			}, [request.seq])

			const running = state.phase === 'running'
			const close = () => {
				if (running) return
				settleRetryRequest()
			}
			const run = () => {
				setState((previous) => ({ ...previous, phase: 'running', error: null, result: null }))
				retryPending().then(
					(result) => {
						setState((previous) => ({ ...previous, phase: 'ready', result, value: null, error: null }))
					},
					(reason) => {
						setState((previous) => ({ ...previous, phase: 'ready', error: describeFailure(reason, t) }))
					},
				)
			}

			const lines = []
			if (state.phase === 'reading') lines.push(t('pending.loading'))
			if (state.phase === 'ready' && state.result === null && state.error === null) {
				const count = state.value?.sessionIds?.length ?? 0
				lines.push(count === 0 ? t('pending.none') : t('pending.count', { count }))
			}
			if (state.result !== null) {
				if (state.result.deleted > 0) lines.push(t('pending.done', { count: state.result.deleted }))
				if (state.result.stillStaged > 0) lines.push(t('pending.still', { count: state.result.stillStaged }))
				if (state.result.dropped > 0) lines.push(t('pending.drop', { count: state.result.dropped }))
				if (state.result.deleted === 0 && state.result.stillStaged === 0 && state.result.dropped === 0) {
					lines.push(t('pending.none'))
				}
			}

			return jsxs(primitives.Modal, {
				open: true,
				onClose: close,
				closeLabel: t('close'),
				title: t('pending.title'),
				description: t('pending.lead'),
				footer: jsxs(Fragment, {
					children: [
						jsx(primitives.Button, {
							variant: 'outline',
							disabled: running,
							onClick: close,
							children: t('close'),
						}),
						jsx(primitives.Button, {
							variant: 'outline',
							disabled: running || state.phase === 'reading',
							onClick: run,
							children: running ? t('pending.running') : t('pending.retry'),
						}),
					],
				}),
				children: [
					...lines.map((line, index) =>
						jsx('div', { className: 'dsh-ap-status', role: 'status', children: line }, `line-${String(index)}`),
					),
					state.error === null
						? null
						: jsx('div', { className: 'dsh-ap-error', role: 'alert', children: t('pending.fail', { message: state.error }) }),
				],
			})
		}

		/** The `shell.overlay` entry: nothing pending renders nothing at all. */
		function DeleteSessionDialog({ useDeleteRequest, settleDeleteRequest, deleteSession, t }) {
			const request = useDeleteRequest((pending) => pending)
			if (request === null) return null
			return jsx(
				DeleteSessionConfirm,
				{ request, settleDeleteRequest, deleteSession, t },
				request.sessionId,
			)
		}

		/**
		 * The message to show for one failed attempt: a localized explanation for a
		 * refusal this plugin knows, and the Host's own code and text otherwise.
		 * @param reason - the thrown value.
		 * @param t - the locale seat.
		 * @returns display text.
		 */
		function describeFailure(reason, t) {
			const code = reason instanceof Error ? reason.code : undefined
			const key = typeof code === 'string' ? FAILURE_COPY[code] : undefined
			if (key !== undefined) return t(key)
			const message = reason instanceof Error ? reason.message : String(reason)
			return t('failed', { message: typeof code === 'string' ? `${code}: ${message}` : message })
		}

		/** One request's dialog: in-flight and error state die with the request. */
		function DeleteSessionConfirm({ request, settleDeleteRequest, deleteSession, t }) {
			const [pending, setPending] = React.useState(false)
			const [error, setError] = React.useState(null)
			const close = () => {
				if (pending) return
				settleDeleteRequest()
			}
			const confirm = () => {
				setPending(true)
				setError(null)
				deleteSession(request.sessionId)
					.then(() => {
						setPending(false)
						// Success is the row leaving the sidebar; the dialog just closes.
						settleDeleteRequest()
					})
					.catch((reason) => {
						setPending(false)
						setError(describeFailure(reason, t))
					})
			}
			return jsxs(primitives.Modal, {
				open: true,
				onClose: close,
				closeLabel: t('close'),
				title: t('confirm.title'),
				description: t('confirm.desc', { title: request.displayTitle }),
				footer: jsxs(Fragment, {
					children: [
						jsx(primitives.Button, {
							variant: 'outline',
							disabled: pending,
							onClick: close,
							children: t('cancel'),
						}),
						jsx(primitives.Button, {
							variant: 'outline',
							className: 'dsh-ap-danger',
							disabled: pending,
							onClick: confirm,
							children: t('confirm.action'),
						}),
					],
				}),
				children: [
					pending ? jsx('div', { className: 'dsh-ap-status', role: 'status', children: t('confirm.pending') }) : null,
					error === null ? null : jsx('div', { className: 'dsh-ap-error', role: 'alert', children: t('failed', { message: error }) }),
				],
			})
		}

		/** Cordis services the browser half consumes. */
		const inject = ['slots', 'workspaces', 'locale']

		/**
		 * Register the two row actions and the confirmation dialog.
		 * @param ctx - client root Context.
		 */
		function apply(ctx) {
			installStyles(globalThis.document)

			const workspaces = ctx.get('workspaces')
			const sessions = ctx.get('sessions')
			// The Host's archive set, streamed with the Workspace projection.
			const archivedSet = derive(workspaces.list, (snapshot) => new Set(snapshot.archivedSessionIds))

			// One pending deletion at a time; `seq` lets an identical row raise the
			// dialog again after a cancelled attempt.
			const deleteRequest = createSnapshotStore(null)
			let seq = 0
			const requestDelete = (sessionId, displayTitle) => {
				deleteRequest.set({ sessionId, displayTitle, seq: (seq += 1) })
			}
			const settleDeleteRequest = () => {
				deleteRequest.set(null)
			}

			/**
			 * One authenticated Host call on this plugin's route, reduced to its value.
			 *
			 * Every verb shares this seat so the refusal envelope is interpreted in
			 * exactly one place, and the code is carried on the Error so a caller can
			 * pick its own localized copy — the Host's own text stays as the fallback
			 * for a code added later.
			 *
			 * @param body - the request body, including its `action`.
			 * @returns the response's `value` field.
			 */
			const postRoute = async (body) => {
				const response = await fetch(new URL(ROUTE_PATH.slice(1), document.baseURI), {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(body),
					credentials: 'same-origin',
				})
				const text = await response.text()
				let payload
				try {
					payload = JSON.parse(text)
				} catch {
					throw new Error(`unexpected Host response (HTTP ${String(response.status)})`)
				}
				if (payload?.ok !== true) {
					const refusal = payload?.error
					if (refusal === undefined || refusal === null) {
						throw new Error(`the Host refused the request (HTTP ${String(response.status)})`)
					}
					const error = new Error(String(refusal.message ?? 'refused'))
					error.code = refusal.code
					throw error
				}
				return payload
			}

			const deleteSession = async (sessionId) => {
				const payload = await postRoute({ action: ACTION_DELETE, sessionId })
				// The Host pushes `api-session/removed`, which drops the archived row
				// immediately; a baseline pull also clears it from "All conversations",
				// where an unarchived row would otherwise linger until the next refresh.
				try {
					if (typeof sessions?.refresh === 'function') Promise.resolve(sessions.refresh()).catch(() => {})
				} catch {
					// The push already removed the row; a failed extra pull changes nothing.
				}
				return payload.value
			}

			/** What is staged for the next start, without touching it. */
			const listPending = async () => (await postRoute({ action: ACTION_LIST_PENDING })).value

			/**
			 * Run the stored cleanup pass right now.
			 *
			 * This is the seat that replaces a Host restart: a Session the Host has
			 * since released is purged on the spot, and one it still holds stays staged
			 * and is reported back. The Host re-checks every precondition, so nothing
			 * here can widen what may be deleted.
			 */
			const retryPending = async () => (await postRoute({ action: ACTION_RETRY_PENDING })).value

			ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'archive-purge: dictionaries')

			/**
			 * One retry dialog at a time, on its own store: the cleanup is not tied to a
			 * Session row, so it must not share the deletion request's slot.
			 */
			const retryRequest = createSnapshotStore(null)
			let retrySeq = 0
			const requestRetry = () => {
				retryRequest.set({ seq: (retrySeq += 1) })
			}
			const settleRetryRequest = () => {
				retryRequest.set(null)
			}

			const rowInjected = () => ({
				hooks: { archived: archivedSet },
				requestDelete,
			})
			const dialogInjected = () => ({
				hooks: { deleteRequest },
				settleDeleteRequest,
				deleteSession,
			})
			const retryInjected = () => ({
				hooks: { retryRequest },
				settleRetryRequest,
				listPending,
				retryPending,
			})

			ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
				name: 'sidebar.workspaces.session.menu.item',
				id: 'archive-purge.delete',
				order: MENU_ORDER,
				locale: NS,
				inject: rowInjected,
			}, DeleteSessionMenuItem))

			ctx.slots.inject('sidebar.workspaces.session.row.action', () => ctx.slots.register({
				name: 'sidebar.workspaces.session.row.action',
				id: 'archive-purge.delete',
				order: BUTTON_ORDER,
				locale: NS,
				inject: rowInjected,
			}, DeleteSessionRowButton))

			ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
				name: 'sidebar.workspaces.session.menu.item',
				id: 'archive-purge.retry-pending',
				order: RETRY_MENU_ORDER,
				locale: NS,
				inject: retryInjected,
			}, RetryPendingMenuItem))

			ctx.slots.inject('shell.overlay', () => ctx.slots.register({
				name: 'shell.overlay',
				id: 'archive-purge.delete-dialog',
				locale: NS,
				inject: dialogInjected,
			}, DeleteSessionDialog))

			ctx.slots.inject('shell.overlay', () => ctx.slots.register({
				name: 'shell.overlay',
				id: 'archive-purge.pending-dialog',
				locale: NS,
				inject: retryInjected,
			}, PendingPurgeDialog))
		}

		exports.name = 'archive-purge'
		exports.inject = inject
		exports.apply = apply
		// The refusal-copy table is the one pure function worth reaching from the
		// headless bundle test; Cordis ignores exports it does not know.
		exports.describeFailure = describeFailure
		return module.exports
	},
})
