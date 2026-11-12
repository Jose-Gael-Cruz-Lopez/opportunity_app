import { Glass, Kicker } from "./ui";

/** Screen 1: what the student gets (matches in about five minutes, then a real start), before any question. */
export function WelcomeStep({ onStart, resumable, onRestart }: { onStart: () => void; resumable: boolean; onRestart: () => void }) {
  return (
    <Glass className="st-enter" aria-labelledby="st-welcome-title">
      <Kicker>Five minutes to your matches, then one real start</Kicker>
      <h1 id="st-welcome-title" className="st-h1">
        Find the opportunities that fit you, and start one today.
      </h1>
      <p className="st-lede">
        Answer a few quick questions, add your resume if you have one, and in about five minutes Novus shows your strongest fits. Then you
        pick one and take the first real steps toward applying, in about four more minutes.
      </p>
      <ol className="st-promise" aria-label="What happens next">
        <li>
          <span className="st-dot">2:30</span>
          <span>About a dozen tap questions. Skip any you like.</span>
        </li>
        <li>
          <span className="st-dot">1:00</span>
          <span>Your resume, read on this device only. No resume? Three quick questions instead.</span>
        </li>
        <li>
          <span className="st-dot">0:30</span>
          <span>Your matches, each with plain reasons.</span>
        </li>
        <li>
          <span className="st-dot">4:00</span>
          <span>Your first application started: save it, check you're eligible, write two sentences.</span>
        </li>
      </ol>
      <div className="st-actions">
        <button type="button" className="st-btn st-btn-go" onClick={onStart} autoFocus>
          {resumable ? "Pick up where you left off" : "Let's go"}
        </button>
        {resumable && (
          <button type="button" className="st-btn st-btn-ghost" onClick={onRestart}>
            Start over
          </button>
        )}
      </div>
      <p className="st-meta" style={{ marginTop: 16 }}>
        No account needed until you choose to save your plan. Nothing you type here is shared without asking you first.
      </p>
    </Glass>
  );
}
