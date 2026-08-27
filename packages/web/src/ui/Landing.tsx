import { useState } from 'react';
import { EXAMPLES, parseRepoInput } from '../state/repo.js';

/* Copy is design material. Plain verbs, sentence case, no filler; the empty
 * state is an invitation to act, and errors say what happened and what to do. */

export function Landing({ onOpen }: { onOpen: (owner: string, name: string) => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = (raw: string) => {
    const ref = parseRepoInput(raw);
    if (!ref) {
      setError('That does not look like a GitHub repository. Try a URL, or owner/repo.');
      return;
    }
    setError(null);
    onOpen(ref.owner, ref.name);
  };

  return (
    <main className="landing">
      <div className="landing-plate">
        <header className="landing-head">
          <p className="eyebrow">Specimen plate no. 1</p>
          <h1 className="display">
            Every repository <em>is</em> a tree.
          </h1>
          <p className="lede">
            Paste a public GitHub repository and watch its commits grow, in order, from a seed. The trunk is the
            first-parent chain. The limbs are branches that really existed. The rings are time.
          </p>
        </header>

        <form
          className="landing-form"
          onSubmit={(e) => {
            e.preventDefault();
            submit(value);
          }}
        >
          <label className="visually-hidden" htmlFor="repo">
            GitHub repository
          </label>
          <input
            id="repo"
            className="mono"
            value={value}
            autoComplete="off"
            spellCheck={false}
            placeholder="github.com/owner/repo"
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
          />
          <button type="submit" className="primary">
            Plant it
          </button>
        </form>
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}

        <section className="examples">
          <h2 className="eyebrow">Or start from one of these</h2>
          <ul>
            {EXAMPLES.map((ex) => (
              <li key={ex.ref}>
                <button
                  type="button"
                  onClick={() => submit(ex.ref)}
                  className="example"
                >
                  <span className="mono ref">{ex.ref}</span>
                  <span className="note">{ex.note}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <footer className="landing-foot">
          <p>
            Public repositories only. Nothing is stored: the history is read on request and cached at the edge for an
            hour.
          </p>
        </footer>
      </div>
    </main>
  );
}
