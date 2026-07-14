import { ProcessTerminal, TUI } from "@gajae-code/tui";
import { type SessionSelectionResult, SessionSelectorComponent } from "../modes/components/session-selector";
import { type SessionInfo, SessionManager } from "../session/session-manager";

/** Show the read-only TUI session picker and return the user's consent intent. */
export async function selectSession(sessions: SessionInfo[]): Promise<SessionSelectionResult> {
	const { promise, resolve } = Promise.withResolvers<SessionSelectionResult>();
	const ui = new TUI(new ProcessTerminal());

	let settled = false;
	const settle = (selection: SessionSelectionResult): void => {
		if (settled) return;
		settled = true;
		ui.stop();
		resolve(selection);
	};
	const selector = new SessionSelectorComponent(
		sessions,
		() => {},
		() => settle({ kind: "cancelled" }),
		() => settle({ kind: "cancelled" }),
		async session => {
			await SessionManager.deleteManagedCandidate(session.path);
			return true;
		},
		SessionManager.inspectSessionTailReadOnly,
		settle,
	);
	selector.setOnRequestRender(() => ui.requestRender());
	ui.addChild(selector);
	ui.setFocus(selector);
	ui.start();
	return promise;
}
