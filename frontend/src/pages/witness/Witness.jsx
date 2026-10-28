/*
  WITNESS WINDOW - a live, voice-led interview with a sketch artist.

  Evidence wall layout (1440 x 900 reference):
    top        NISHAAN strip | "WITNESS VIEW ACTIVE" red stamp + line | "PAUSE SCREEN" red stamp
    left       EVIDENCE INDEX: header strip, four menu strips, forensics index card
    centre     tall manila sheet: the pencil sketch, drawn feature by feature as the witness talks
    right      notepad: the artist's question (shown and spoken), the witness's words appearing
               live as they speak, and a few square buttons
    bottom     "take all the time you need"

  Flow: the artist asks an open question (text + voice) -> the witness answers by voice (words
  appear on screen as they speak) or by typing -> while they talk, the sketch is redrawn from
  the words so far -> one backend call updates the description and returns the next direct
  question -> the drawing is saved and refined into a realistic forensic pencil portrait ->
  repeat. Spoken corrections ("make the jaw a bit wider") reshape the drawing. No multiple
  choice. The witness only ever sees pencil drawings.
*/
import { useCallback, useEffect, useRef, useState } from "react";
import { Board, Pin } from "../../components/Board.jsx";
import { PinStrings } from "../../components/PinStrings.jsx";
import { Paper, Stamp, InkButton } from "../../components/Paper.jsx";
import { PauseGlyph, ArrowGlyph, MicGlyph } from "../../components/Glyph.jsx";
import SketchCanvas from "../../components/SketchCanvas.jsx";
import SketchAnnotator, { pinsToText } from "../../components/SketchAnnotator.jsx";
import AuthImage from "../../components/AuthImage.jsx";
import SceneMap from "../../components/SceneMap.jsx";
import { lazy, Suspense } from "react";
import { api, ApiError, storeWitnessToken, takeWitnessToken, waitJob } from "../../lib/api.js";
import { useT } from "../../lib/i18n.js";
import { tilt } from "../../lib/rng.js";
import { useListener, useSpeaker } from "../../lib/useVoice.js";
import { CaptionStrip, HeadingStrip, L, WordsBox, WorkingNote } from "./parts.jsx";
import "../../styles/wall.css";
import "../../styles/witness.css";

const CrimeScene3D = lazy(() => import("../../components/CrimeScene3D.jsx"));


const MENU = [
  ["sketch", "Composite sketch"],
  ["scene", "Crime scene wall"],
  ["vault", "Evidentiary vault"],
  ["timeline", "Incident timeline"],
];
const SIGN_FEATURES = ["face_shape", "eyes", "brows", "nose", "mouth", "jaw", "hair"];
const CONF = { high: "sure", medium: "somewhat", low: "guessing", not_remembered: "not_remembered" };
const POLL_MS = 1500;
const PREVIEW_EVERY_WORDS = 3;

// ------------------------------------------------------------------------------------------

function Gate({ sid, onToken }) {
  const t = useT("kn");
  const [code, setCode] = useState("");
  const [err, setErr] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    try {
      await api(`/sessions/${sid}`, { token: code.trim() });
      storeWitnessToken(sid, code.trim());
      onToken(code.trim());
    } catch {
      setErr(true);
    }
  };
  return (
    <Board className="witness gate" links={[["ring-tma", "gate-pin"]]}>
      <form className="gate-form" onSubmit={submit}>
        <Paper seed="gate" rotate={-0.6} pins={[{ id: "gate-pin", x: "50%" }]}>
          <L lang="kn" as="h1" className="gate-title">
            {t("gateHeading")}
          </L>
          <p className="gate-sub" lang="hi">
            अधिकारी का दिया हुआ कोड डालिए
          </p>
          <p className="gate-sub">Enter the code the officer gave you</p>
          <label className="sr-only" htmlFor="code">
            Code
          </label>
          <input id="code" className="paper-input" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" spellCheck="false" />
          {err && (
            <p className="error-note" lang="kn">
              {t("expired")}
            </p>
          )}
          <InkButton variant="solid" type="submit" glyph={<ArrowGlyph />} disabled={!code.trim()}>
            Continue
          </InkButton>
        </Paper>
      </form>
    </Board>
  );
}

export default function Witness({ sid }) {
  const [token, setToken] = useState(() => takeWitnessToken(sid));
  if (!token) return <Gate sid={sid} onToken={setToken} />;
  return <WitnessWindow sid={sid} token={token} />;
}

// ------------------------------------------------------------------------------------------

function WitnessWindow({ sid, token }) {
  const [session, setSession] = useState(null);
  const [lang, setLang] = useState("kn");
  const t = useT(lang);
  const [view, setView] = useState("sketch");
  const [paused, setPaused] = useState(false);
  const [officerPaused, setOfficerPaused] = useState(false);
  const [ended, setEnded] = useState(null); // "expired" | "done"
  const [notice, setNotice] = useState(null);

  // live interview
  const [live, setLive] = useState(null); // {started, question_local, ask_field, sheet, adjust}
  const [phase, setPhase] = useState("idle"); // idle | speaking | listening | thinking | ready | finishing | signoff
  const [typing, setTyping] = useState(false);
  const [muted, setMuted] = useState(false);
  const [log, setLog] = useState([]);
  const [lastHeard, setLastHeard] = useState("");
  const [closingWords, setClosingWords] = useState("");
  const listener = useListener(lang, { sid, token });
  const speaker = useSpeaker(token);
  const running = useRef(false);

  // live sketch: newest pencil drawing + whether a realistic portrait is still being made
  const [frame, setFrame] = useState(null);
  const [refining, setRefining] = useState(false);
  const [missed, setMissed] = useState(0);
  const seqRef = useRef(0);
  const needCommit = useRef(false);
  const previewBusy = useRef(false);
  const previewWant = useRef(null);
  const previewWords = useRef(0);

  const call = useCallback(
    async (path, opts = {}) => {
      try {
        return await api(path, { ...opts, token });
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          setEnded("expired");
          storeWitnessToken(sid, null);
        }
        if (e instanceof ApiError && e.code === "session_not_active") setOfficerPaused(true);
        throw e;
      }
    },
    [token, sid],
  );

  const job = useCallback(
    async (path, opts = {}) => {
      const accepted = await call(path, { method: "POST", ...opts });
      return waitJob(accepted.job_id, { token, interval: 450 });
    },
    [call, token],
  );

  const fail = useCallback(
    (e) => {
      if (e instanceof ApiError && (e.status === 401 || e.code === "session_not_active")) return;
      if (e instanceof ApiError && e.code === "empty_turn") setNotice({ kind: "warn", text: t("noSpeech") });
      else setNotice({ kind: "warn", text: t("genericError") });
    },
    [t],
  );

  const loadSession = useCallback(async () => {
    const s = await call(`/sessions/${sid}`);
    setSession(s);
    setLang(["kn", "hi", "en"].includes(s.preferred_language) ? s.preferred_language : "kn");
    setOfficerPaused(s.status === "paused");
    if (s.status === "signed_off") setEnded("done");
    return s;
  }, [call, sid]);

  useEffect(() => {
    loadSession()
      .then(() => call(`/sessions/${sid}/interview/live`))
      .then(setLive)
      .catch(() => {});
  }, [loadSession, call, sid]);

  useEffect(() => {
    if (!officerPaused) return undefined;
    const iv = setInterval(() => {
      api(`/sessions/${sid}`, { token })
        .then((s) => {
          if (s.status === "active") {
            setOfficerPaused(false);
            setSession(s);
          }
        })
        .catch(() => {});
    }, 4000);
    return () => clearInterval(iv);
  }, [officerPaused, sid, token]);

  const reportShown = useCallback(
    (body) => {
      call(`/sessions/${sid}/display-events`, { method: "POST", body }).catch(() => {});
    },
    [call, sid],
  );

  // ---- live sketch ----------------------------------------------------------------------------
  const showRender = useCallback((r, { allowDowngrade = true } = {}) => {
    if (!r || !r.sketch_b64 || !r.lines_b64) return false;
    if (typeof r.seq === "number") seqRef.current = Math.max(seqRef.current, r.seq);
    const id = `${r.kind}:${r.sketch_b64.length}:${r.sketch_b64.slice(-32)}`;
    setFrame((f) => {
      // Never replace a portrait with a generic instant/library frame — it looks like a
      // regression to the witness. Only upgrade (instant → portrait) or show instant when
      // there is no existing frame yet.
      if (f && f.id === id) return f;
      if (!allowDowngrade && f?.kind === "portrait" && r.kind !== "portrait") return f;
      return { id, kind: r.kind, lines: `data:image/jpeg;base64,${r.lines_b64}`, shade: `data:image/jpeg;base64,${r.sketch_b64}` };
    });
    setRefining(!!r.pending);
    return true;
  }, []);

  /** Save what the witness is looking at as a sketch version (the instant drawing now, the
   *  realistic portrait again when it arrives). */
  const commitRender = useCallback(
    async (wait_s = 0, { showInstant = true } = {}) => {
      try {
        const r = await call(`/sessions/${sid}/interview/render`, { method: "POST", body: { commit: true, wait_s } });
        if (r.ready) {
          // When called right after a turn (showInstant=false) don't overwrite a portrait
          // with the instant library face — keep the previous image on screen while the
          // background worker generates the new portrait for the updated description.
          showRender(r, { allowDowngrade: showInstant });
          needCommit.current = r.kind !== "portrait";
          if (r.version_id) reportShown({ sketch_version_id: r.version_id, screen: "live_sketch" });
        }
        // If the background portrait worker is now running, start polling for it.
        if (r.pending) setRefining(true);
        return r;
      } catch {
        return null;
      }
    },
    [call, sid, showRender, reportShown],
  );

  /** Redraw from the words still being spoken (one request at a time, newest words win). */
  const preview = useCallback(
    async (text) => {
      previewWant.current = text;
      if (previewBusy.current) return;
      previewBusy.current = true;
      try {
        while (previewWant.current !== null) {
          const words = previewWant.current;
          previewWant.current = null;
          const r = await call(`/sessions/${sid}/interview/render`, { method: "POST", body: words ? { text: words } : {} });
          // Never downgrade a portrait to an instant frame during live speech
          if (r.ready) showRender(r, { allowDowngrade: false });
          else if (r.pending) setRefining(true);
        }
      } catch {
        /* the drawing waits for the next words */
      } finally {
        previewBusy.current = false;
      }
    },
    [call, sid, showRender],
  );

  // words appearing while the witness talks -> redraw every few new words
  useEffect(() => {
    const text = (listener.interim || "").trim();
    if (!text || phase !== "listening") return;
    const n = text.split(/\s+/).length;
    if (n - previewWords.current < PREVIEW_EVERY_WORDS) return;
    previewWords.current = n;
    preview(text);
  }, [listener.interim, phase, preview]);

  // a realistic portrait is being made in the background: pick it up when it is ready
  useEffect(() => {
    if (!refining) return undefined;
    let stop = false;
    const iv = setInterval(async () => {
      try {
        const r = await call(`/sessions/${sid}/interview/render/latest?after=${seqRef.current}`);
        if (stop) return;
        if (r.sketch_b64) {
          // Only allow upgrading (instant→portrait). Never downgrade portrait→instant during polling.
          showRender(r, { allowDowngrade: r.kind === "portrait" });
          if (needCommit.current && r.kind === "portrait") commitRender(0);
        } else if (!r.pending) setRefining(false);
      } catch {
        setRefining(false);
      }
    }, POLL_MS);
    return () => {
      stop = true;
      clearInterval(iv);
    };
  }, [refining, call, sid, showRender, commitRender]);

  // returning to a session that already has a description: show its drawing
  const restored = useRef(false);
  useEffect(() => {
    if (!live?.started || restored.current) return;
    restored.current = true;
    preview("");
  }, [live, preview]);

  // microphone problems: say so and open the typing box
  useEffect(() => {
    if (!listener.error) return;
    setNotice({ kind: "warn", text: listener.error === "denied" ? t("micDenied") : t("micOff") });
    setTyping(true);
  }, [listener.error, t]);
  useEffect(() => {
    if (missed) setNotice({ kind: "warn", text: t("noSpeech") });
  }, [missed, t]);

  // ---- the interview loop -------------------------------------------------------------------
  const ask = useCallback(
    async (text) => {
      setPhase("speaking");
      await speaker.speak(text, lang, { muted });
    },
    [speaker, lang, muted],
  );

  const sendTurn = useCallback(
    async (payload) => {
      setPhase("thinking");
      setNotice(null);
      try {
        let res;
        if (payload.audio) {
          const fd = new FormData();
          fd.append("audio", payload.audio);
          fd.append("language", lang);
          res = await call(`/sessions/${sid}/interview/turn`, { method: "POST", form: fd });
        } else {
          res = await call(`/sessions/${sid}/interview/turn`, { method: "POST", body: payload });
        }
        setLog((l) => [...l, { who: "witness", text: res.transcript_original || "…" }, { who: "artist", text: res.reply_local }].slice(-6));
        setLastHeard(res.transcript_original || "");
        setLive((v) => ({ ...v, started: true, sheet: res.sheet, adjust: res.adjust, question_local: res.reply_local, ask_field: res.ask_field }));
        // Kick off a background portrait for the updated description.
        // showInstant=false so we don't flash the generic library face over an existing portrait.
        commitRender(0, { showInstant: false });
        return res;
      } catch (e) {
        fail(e);
        return null;
      }
    },
    [call, sid, lang, fail, commitRender],
  );

  // one cycle: speak the question, listen, send, repeat (stops when halted)
  const loopTicket = useRef(0);
  const cycle = useCallback(
    async (question) => {
      if (running.current) return; // one interview loop at a time
      running.current = true;
      const mine = ++loopTicket.current;
      const alive = () => running.current && loopTicket.current === mine;
      let q = question;
      while (alive()) {
        await ask(q);
        if (!alive()) break;
        setPhase("listening");
        previewWords.current = 0;
        const heard = await listener.listen();
        if (!alive() || heard.cancelled) break;
        if (heard.audio) {
          if (heard.text) setLastHeard(heard.text);
          const res = await sendTurn({ audio: heard.audio });
          if (!alive()) break;
          if (!res) {
            setPhase("ready");
            running.current = false;
            break;
          }
          q = res.reply_local;
        } else {
          setMissed((m) => m + 1);
          setPhase("ready");
          running.current = false;
          break;
        }
      }
    },
    [ask, listener, sendTurn],
  );

  const halt = useCallback(() => {
    running.current = false;
    loopTicket.current += 1;
    listener.cancel();
    speaker.stopSpeaking();
    setPhase((p) => (p === "signoff" ? p : "ready"));
  }, [listener, speaker]);

  const start = () => {
    setNotice(null);
    cycle(live?.question_local || "");
  };
  const doneSpeaking = () => listener.stop();
  const repeat = async () => {
    halt();
    await ask(live?.question_local || "");
    setPhase("ready");
  };
  const [annotating, setAnnotating] = useState(false);
  const [pins, setPins] = useState([]);

  const addPin = (pin) => setPins((p) => [...p, pin]);
  const removePin = (id) => setPins((p) => p.filter((x) => x.id !== id));
  const clearPins = () => setPins([]);

  const typed = async (text) => {
    // prepend any pending annotation notes
    const pinText = pinsToText(pins);
    const fullText = pinText ? `${pinText} ${text}` : text;
    clearPins();
    setAnnotating(false);
    halt();
    const res = await sendTurn({ text: fullText, language: lang, source: "typed" });
    if (res) {
      await ask(res.reply_local);
      setPhase("ready");
    }
  };
  const dontRemember = async () => {
    halt();
    const res = await sendTurn({ dont_remember: true });
    if (res) cycle(res.reply_local);
  };

  useEffect(() => () => (running.current = false), []);
  useEffect(() => {
    if (paused) halt();
  }, [paused, halt]);

  // ---- finish: save the drawing, last words, sign-off ----------------------------------------
  const finish = async () => {
    halt();
    setPhase("finishing");
    try {
      const r = await commitRender(25); // the realistic portrait if it is ready by now
      if (!r?.version_id) throw new Error("no sketch");
      setPhase("signoff");
      await speaker.speak(t("finishAsk"), lang, { muted });
    } catch (e) {
      fail(e);
      setPhase("ready");
    }
  };
  const signOff = async () => {
    setPhase("finishing");
    try {
      const sheet = live?.sheet || {};
      const confidences = Object.fromEntries(SIGN_FEATURES.map((f) => [f, CONF[sheet[f]?.confidence] || "not_remembered"]));
      const latest = await call(`/sessions/${sid}`);
      await call(`/sessions/${sid}/signoff`, {
        method: "POST",
        body: { sketch_version_id: latest.latest_sketch_version_id, confidences, witness_statement: closingWords },
      });
      storeWitnessToken(sid, null);
      setEnded("done");
    } catch (e) {
      fail(e);
      setPhase("signoff");
    }
  };

  // ---- panel -------------------------------------------------------------------------------
  const busy = phase === "thinking" || phase === "finishing";
  const question = phase === "signoff" ? t("finishAsk") : live?.question_local;
  const statusLine =
    phase === "listening"
      ? listener.heardVoice
        ? t("heardYou")
        : t("listeningLine")
      : phase === "thinking"
        ? t("thinkingLine")
        : phase === "speaking"
          ? t("speakingLine")
          : t("youSaid");

  const panel =
    view !== "sketch" ? (
      <SideNote t={t} view={view} onBack={() => setView("sketch")} />
    ) : (
      <div className="choose interview">
        <Paper seed="artist-head" rotate={-0.6} jag={2.4} className="choose-head">
          <L lang={lang} as="h2" className="choose-title">
            {t("artist")}
          </L>
        </Paper>
        <Paper seed="question-note" rotate={0.7} jag={2} className="question-note">
          <p className="question-text hand" lang={lang} aria-live="polite">
            {question || t("working")}
          </p>
        </Paper>

        <Paper seed="heard" rotate={-0.5} jag={2} className={`heard-note ${phase === "listening" ? "is-listening" : ""}`}>
          <p className="heard-label" lang={lang}>
            {phase === "listening" && <span className="rec-dot" aria-hidden="true" />} {statusLine}
          </p>
          {phase === "listening" && (
            <div className="mic-level" aria-hidden="true">
              <span style={{ width: `${Math.round(listener.level * 100)}%` }} />
            </div>
          )}
          <p className="heard-text" lang={lang} aria-live="polite">
            {phase === "listening" ? <span className="interim">{listener.interim}</span> : lastHeard}
          </p>
        </Paper>

        {notice && (
          <Paper seed="notice" rotate={-0.4} className={`notice-note notice-${notice.kind}`}>
            <L lang={lang} as="p">
              {notice.text}
            </L>
          </Paper>
        )}

        {typing && phase !== "signoff" && (
          <div className="type-box">
            <WordsBox t={t} busy={busy} onText={typed} onAudio={(file) => sendTurn({ audio: file })} placeholder={t("typeHere")} submitLabel="Send" />
          </div>
        )}
        {phase === "signoff" && (
          <div className="type-box">
            <label className="sr-only" htmlFor="closing">
              {t("finishNote")}
            </label>
            <textarea id="closing" className="paper-input" lang={lang} placeholder={t("finishNote")} value={closingWords} onChange={(e) => setClosingWords(e.target.value)} />
          </div>
        )}

        <div className="choose-actions">
          {phase === "signoff" ? (
            <InkButton variant="solid" className="continue big" onClick={signOff} glyph={<ArrowGlyph />}>
              Sign and finish
            </InkButton>
          ) : (
            <>
              {phase === "idle" || phase === "ready" ? (
                <InkButton variant="solid" className="continue big" onClick={start} disabled={!live || officerPaused} glyph={<MicGlyph />}>
                  {phase === "idle" && !live?.started ? "Start interview" : "Speak"}
                </InkButton>
              ) : phase === "listening" ? (
                <InkButton variant="solid" className="continue big is-live" onClick={doneSpeaking} glyph={<ArrowGlyph />}>
                  I have finished speaking
                </InkButton>
              ) : (
                <InkButton variant="solid" className="continue big" onClick={halt} disabled={busy}>
                  {phase === "speaking" ? "Skip" : "One moment"}
                </InkButton>
              )}
              <div className="choose-row pair">
                <InkButton onClick={repeat} disabled={busy || !live}>
                  Repeat question
                </InkButton>
                <InkButton onClick={dontRemember} disabled={busy || !live?.started}>
                  I don&apos;t remember
                </InkButton>
                <InkButton onClick={() => setTyping((v) => !v)} disabled={busy} aria-pressed={typing}>
                  {typing ? "Hide typing" : "Type instead"}
                </InkButton>
                <InkButton onClick={() => setMuted((m) => !m)} aria-pressed={muted}>
                  {muted ? "Voice on" : "Voice off"}
                </InkButton>
              </div>
              {live?.started && (
                <InkButton className="finish-btn" onClick={finish} disabled={busy}>
                  Finish sketch
                </InkButton>
              )}
            </>
          )}
        </div>
      </div>
    );

  // ---- centre -------------------------------------------------------------------------------
  let sheet;
  if (view === "scene") sheet = <ScenePane t={t} sid={sid} call={call} job={job} session={session} reloadSession={loadSession} reportShown={reportShown} fail={fail} />;
  else if (view === "vault") sheet = <VaultPane t={t} sid={sid} token={token} call={call} reportShown={reportShown} />;
  else if (view === "timeline") sheet = <TimelinePane t={t} sid={sid} call={call} />;
  else
    sheet = (
      <>
        <HeadingStrip t={t} text={t("sketchHeading")} />
        <div className="sketch-frame live-frame">
          {frame ? (
            <SketchAnnotator
              active={annotating}
              pins={pins}
              onAdd={addPin}
              onRemove={removePin}
              onClear={clearPins}
            >
              <SketchCanvas frame={frame} />
            </SketchAnnotator>
          ) : (
            <L lang={lang} as="p" className="sheet-empty">
              {!live ? t("working") : live.started ? t("drawingNow") : t("startNote")}
            </L>
          )}
          {frame && refining && (
            <L lang={lang} as="p" className="sketch-status">
              {t("refining")}
            </L>
          )}
          {frame && (
            <button
              className={`annot-toggle-btn ${annotating ? "active" : ""}`}
              onClick={() => setAnnotating((a) => !a)}
              title={annotating ? "Done annotating" : "Click sketch to mark a point"}
            >
              {annotating ? "✓ Done marking" : "📍 Mark a point"}
            </button>
          )}
        </div>
        <CaptionStrip t={t} text={frame ? (annotating ? "Click on the sketch to mark what to change" : t("liveCaption")) : t("emptySheet")} />
        {pins.length > 0 && (
          <div className="pins-summary">
            {pins.map((p, i) => (
              <div key={p.id} className="pin-chip">
                <span>📍 {i + 1}. {p.note}</span>
                <button onClick={() => removePin(p.id)}>✕</button>
              </div>
            ))}
          </div>
        )}
        {log.length > 0 && (
          <ol className="talk-log" aria-label="Conversation">
            {log.slice(-2).map((m, i) => (
              <li key={i} className={`talk-${m.who}`} lang={lang}>
                {m.text}
              </li>
            ))}
          </ol>
        )}
      </>
    );

  if (ended) {
    return (
      <Board className="witness ended" links={[["ring-tma", "end-pin"]]}>
        <Paper seed="end" rotate={-0.5} className="end-note" pins={[{ id: "end-pin", x: "50%" }]}>
          <L lang={lang} as="h1">
            {ended === "done" ? t("doneHeading") : t("expired")}
          </L>
          {ended === "done" && (
            <L lang={lang} as="p">
              {t("doneNote")}
            </L>
          )}
        </Paper>
      </Board>
    );
  }

  const links = [
    ["ring-tq1", "brand-pin"],
    ["ring-tma", "stamp-pin"],
    ["ring-lq1", "idx-pin"],
    ["ring-lma", "idx-pin-2"],
    ["idx-pin-2", "card-pin"],
    ["ring-tma", "sheet-tl"],
    ["ring-tmb", "sheet-tr"],
    ["ring-tq3", "pad-head"],
    ["ring-rq1", "pad-head-2"],
    ["ring-bma", "note-pin"],
    ["sheet-bl", "ring-bq1"],
    ["sheet-br", "ring-bq3"],
  ];

  return (
    <Board className={`witness ${paused ? "is-paused" : ""}`} links={links}>
      <header className="w-top">
        <Paper seed="brand" rotate={-1.2} jag={2.4} className="brand-strip" pins={[{ id: "brand-pin", x: "50%" }]}>
          <span className="brand ink">NISHAAN</span>
        </Paper>
        <div className="w-stamp-wrap">
          <span className="stamp-pin-anchor">
            <Pin id="stamp-pin" />
          </span>
          <Stamp rotate={-1.5}>Witness view active</Stamp>
          <L lang={lang} className="wall-line">
            {t("viewActiveLine")}
          </L>
        </div>
        <div className="w-pause-wrap">
          <L lang={lang} className="wall-line">
            {t("pauseLine")}
          </L>
          <Stamp as="button" rotate={1.2} onClick={() => setPaused(true)} aria-label="Pause screen">
            <PauseGlyph size={20} /> Pause screen
          </Stamp>
        </div>
      </header>

      <nav className="w-index" aria-label="Evidence index">
        <Paper seed="idx-head" rotate={-0.8} jag={2.4} className="idx-head" pins={[{ id: "idx-pin", x: "22%" }, { id: "idx-pin-2", x: "80%" }]}>
          <span className="ink">Evidence index</span>
        </Paper>
        <ul className="idx-list">
          {MENU.map(([key, label], i) => (
            <li key={key}>
              <Paper
                seed={`menu-${key}`}
                rotate={tilt(`menu-${key}`, 1.5)}
                jag={2.6}
                className={`menu-strip ${view === key ? "is-selected" : ""}`}
                style={{ width: `${88 + ((i * 7) % 12)}%` }}
                pins={view === key ? [{ id: `menu-pin-${key}`, x: "12%" }] : []}
              >
                <button type="button" className="menu-btn" aria-current={view === key ? "page" : undefined} onClick={() => setView(key)}>
                  <span className="ink">{label}</span>
                </button>
              </Paper>
            </li>
          ))}
        </ul>
        <Paper seed="forensics" rotate={1.2} className="forensics-card" pins={[{ id: "card-pin", x: "50%" }]}>
          <span className="ink">Central Forensics Div.</span>
        </Paper>
      </nav>

      <main className="w-sheet-wrap">
        <Paper
          seed="centre-sheet"
          rotate={0}
          jag={2.2}
          className="w-sheet"
          bodyClass="dot-grid"
          pins={[
            { id: "sheet-tl", x: "7%", y: "-5px" },
            { id: "sheet-tr", x: "93%", y: "-5px" },
            { id: "sheet-bl", x: "7%", y: "calc(100% - 9px)" },
            { id: "sheet-br", x: "93%", y: "calc(100% - 9px)" },
          ]}
        >
          {sheet}
          {officerPaused && <WorkingNote t={t} text={t("officerPaused")} />}
        </Paper>
      </main>

      <aside className="w-pad" aria-label="Interview">
        <Paper seed="notepad" rotate={0.6} jag={2} className="notepad" pins={[{ id: "pad-head", x: "16%" }, { id: "pad-head-2", x: "84%" }]}>
          {panel}
        </Paper>
      </aside>

      <footer className="w-bottom">
        <Paper seed="bottom-note" rotate={-1} jag={2.4} className="bottom-note" pins={[{ id: "note-pin", x: "50%" }]}>
          <L lang={lang} as="p" className="bottom-local">
            {t("bottomNote")}
          </L>
          <p className="bottom-en ink">Take all the time you need. No rush.</p>
        </Paper>
      </footer>

      {paused && (
        <div className="pause-cover" role="dialog" aria-modal="true" aria-label="Screen paused">
          <Board className="pause-board" links={[["ring-tma", "pause-pin"]]}>
            <Paper seed="pause" rotate={-0.6} className="pause-note" pins={[{ id: "pause-pin", x: "50%" }]}>
              <L lang={lang} as="h1">
                {t("pausedHeading")}
              </L>
              <L lang={lang} as="p">
                {t("pausedNote")}
              </L>
              <InkButton variant="solid" autoFocus onClick={() => setPaused(false)} glyph={<ArrowGlyph />}>
                Continue
              </InkButton>
            </Paper>
          </Board>
        </div>
      )}
    </Board>
  );
}

// ---- side note for the non-sketch menu views ------------------------------------------------
function SideNote({ t, view, onBack }) {
  const text = { scene: t("sceneNote"), vault: t("vaultNote"), timeline: t("timelineNote") }[view];
  const head = { scene: t("sceneHeading"), vault: t("vaultHeading"), timeline: t("timelineHeading") }[view];
  return (
    <div className="choose">
      <Paper seed={`side-${view}`} rotate={-0.6} jag={2.4} className="choose-head">
        <L lang={t.lang} as="h2" className="choose-title">
          {head}
        </L>
        <L lang={t.lang} as="p" className="choose-instruction">
          {text}
        </L>
      </Paper>
      <div className="choose-actions">
        <InkButton variant="solid" onClick={onBack} glyph={<ArrowGlyph />}>
          Composite sketch
        </InkButton>
      </div>
    </div>
  );
}

// ---- vault: saved sketches --------------------------------------------------------------------
function VaultPane({ t, sid, token, call, reportShown }) {
  const [tree, setTree] = useState([]);
  const [page, setPage] = useState(0);
  const boxRef = useRef(null);
  const anchors = useRef(new Map()); // sketch version id -> the spot where its pin goes
  useEffect(() => {
    call(`/sessions/${sid}/sketch-tree`)
      .then((rows) => setTree([...rows].reverse()))
      .catch(() => {});
  }, [call, sid]);
  const pages = Math.max(1, Math.ceil(tree.length / 3));
  const rows = tree.slice(page * 3, page * 3 + 3);
  return (
    <div className="vault" ref={boxRef}>
      <HeadingStrip t={t} text={t("vaultHeading")} />
      {tree.length === 0 && (
        <L lang={t.lang} as="p" className="sheet-empty">
          {t("emptySheet")}
        </L>
      )}
      <div className="vault-row">
        {rows.map((v) => (
          <div key={v.id} className="vault-item">
            <div className="polaroid vault-polaroid" style={{ "--rot": `${tilt(v.id, 2)}deg` }}>
              <span className="vault-anchor" ref={(el) => (el ? anchors.current.set(v.id, el) : anchors.current.delete(v.id))} />
              <span className="polaroid-window">
                <AuthImage fileId={v.sketch_file_id} token={token} onShown={() => reportShown({ sketch_version_id: v.id, screen: "vault" })} />
              </span>
            </div>
          </div>
        ))}
      </div>
      <PinStrings containerRef={boxRef} anchorsRef={anchors} ids={rows.map((v) => v.id)} />
      {pages > 1 && (
        <div className="vault-nav">
          <InkButton onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>
            Newer
          </InkButton>
          <InkButton onClick={() => setPage((p) => Math.min(pages - 1, p + 1))} disabled={page >= pages - 1}>
            Older
          </InkButton>
        </div>
      )}
    </div>
  );
}

// ---- timeline: what was asked and said ----------------------------------------------------------
function TimelinePane({ t, sid, call }) {
  const [items, setItems] = useState(null);
  useEffect(() => {
    Promise.all([call(`/sessions/${sid}/statements`), call(`/sessions/${sid}/questions`)])
      .then(([sts, qs]) => {
        const rows = [
          ...sts.map((s) => ({ at: s.created_at, kind: "said", text: s.corrected_transcript_original || s.transcript_original })),
          ...qs.map((q) => ({ at: q.asked_at, kind: "asked", text: q.text_local || q.text_en })),
        ]
          .filter((r) => r.text)
          .sort((a, b) => String(a.at).localeCompare(String(b.at)));
        setItems(rows);
      })
      .catch(() => setItems([]));
  }, [call, sid]);
  return (
    <div className="timeline">
      <HeadingStrip t={t} text={t("timelineHeading")} />
      <div className="timeline-list">
        {(items || []).map((it, i) => (
          <Paper key={i} seed={`tl-${i}`} rotate={tilt(`tl-${i}`, 1.2)} className={`timeline-note tl-${it.kind}`} pins={[{ x: "8%", tone: it.kind === "said" ? "red" : "ink" }]}>
            <p className={it.kind === "asked" ? "hand timeline-q" : "timeline-statement"} lang={t.lang}>
              {it.text}
            </p>
          </Paper>
        ))}
      </div>
    </div>
  );
}

// ---- scene: map of the place -----------------------------------------------------------------------
function ScenePane({ t, sid, call, job, session, reloadSession, reportShown, fail }) {
  const [vid, setVid] = useState(session?.latest_scene_version_id || null);
  const [scene, setScene] = useState(null);
  const [busy, setBusy] = useState(false);
  const [words, setWords] = useState(false);
  const [view3d, setView3d] = useState(false);
  const [uploadedScene, setUploadedScene] = useState(null); // scene from floor plan upload
  const mapFileRef = useRef(null);

  const displayScene = uploadedScene || scene;

  useEffect(() => {
    if (!vid) return;
    call(`/scene-versions/${vid}`)
      .then((v) => {
        setScene(v.scene);
        reportShown({ scene_version_id: v.id, screen: "scene" });
      })
      .catch(() => {});
  }, [vid, call, reportShown]);

  const build = async () => {
    setBusy(true);
    try {
      const res = await job(`/sessions/${sid}/scene`, { body: {} });
      setVid(res.version_id);
      reloadSession();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const move = async (coll, index, pos) => {
    if (uploadedScene) {
      // Update local uploaded scene without persisting
      setUploadedScene((s) => {
        const arr = [...(s[coll] || [])];
        arr[index] = { ...arr[index], pos };
        return { ...s, [coll]: arr };
      });
      return;
    }
    setBusy(true);
    try {
      const v = await call(`/scene-versions/${vid}/patches`, { method: "POST", body: { patch: [{ op: "replace", path: `/${coll}/${index}/pos`, value: pos }], source: "drag" } });
      setVid(v.id);
      setScene(v.scene);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const command = async ({ text, file }) => {
    setBusy(true);
    try {
      let res;
      if (file) {
        const fd = new FormData();
        fd.append("audio", file);
        fd.append("language", t.lang);
        fd.append("kind", "scene_command");
        fd.append("target_version_id", vid);
        res = await job(`/sessions/${sid}/statements`, { form: fd });
      } else res = await job(`/scene-versions/${vid}/commands`, { body: { utterance_original: text, language: t.lang } });
      if (res.version_id) setVid(res.version_id);
      setWords(false);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const uploadMap = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("image", file);
      const result = await call(`/sessions/${sid}/scene/analyze-map`, { method: "POST", form: fd });
      setUploadedScene(result);
      setView3d(true); // auto-switch to 3D on upload
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const personLabel = (p) => (p.role === "witness" ? t("you") : p.role === "suspect" ? t("person") : t("other"));

  return (
    <div className="scene-pane">
      <HeadingStrip t={t} text={t("sceneHeading")} />

      {/* View controls */}
      {displayScene && (
        <div className="scene-view-controls">
          <button
            className={`scene-view-btn ${!view3d ? "active" : ""}`}
            onClick={() => setView3d(false)}
          >
            🗺 2D Map
          </button>
          <button
            className={`scene-view-btn ${view3d ? "active" : ""}`}
            onClick={() => setView3d(true)}
          >
            🏠 3D View
          </button>
          {/* Upload a floor plan image to generate 3D scene */}
          <button
            className="scene-view-btn upload-btn"
            onClick={() => mapFileRef.current?.click()}
            disabled={busy}
          >
            📤 Upload Map
          </button>
          <input
            ref={mapFileRef}
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) uploadMap(f);
            }}
          />
          {uploadedScene && (
            <button className="scene-view-btn" onClick={() => { setUploadedScene(null); setView3d(false); }}>
              ✕ Clear upload
            </button>
          )}
        </div>
      )}

      {displayScene ? (
        <>
          <div className={`scene-frame ${view3d ? "scene-frame-3d" : ""}`}>
            {view3d ? (
              <Suspense fallback={<div className="scene3d-loading">Loading 3D view…</div>}>
                <CrimeScene3D
                  scene={displayScene}
                  editable={true}
                  onMove={move}
                  personLabel={personLabel}
                />
              </Suspense>
            ) : (
              <SceneMap
                scene={displayScene}
                editable={!busy}
                onMove={move}
                labelFor={(o) => t.object(o.type)}
                personLabel={personLabel}
              />
            )}
          </div>
          {!view3d && (words ? (
            <WordsBox t={t} busy={busy} onText={(text) => command({ text })} onAudio={(file) => command({ file })} />
          ) : (
            <div className="scene-actions">
              <InkButton onClick={() => setWords(true)} disabled={busy}>
                Say the change
              </InkButton>
            </div>
          ))}
        </>
      ) : (
        <div className="scene-empty">
          <L lang={t.lang} as="p">
            {t("sceneEmpty")}
          </L>
          <div className="scene-empty-btns">
            <InkButton variant="solid" onClick={build} disabled={busy || !session?.has_free_recall} glyph={<ArrowGlyph />}>
              Build the place
            </InkButton>
            <InkButton onClick={() => mapFileRef.current?.click()} disabled={busy}>
              📤 Upload floor plan
            </InkButton>
            <input
              ref={mapFileRef}
              type="file"
              accept="image/*"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) uploadMap(f);
              }}
            />
          </div>
        </div>
      )}
      {busy && <WorkingNote t={t} />}
    </div>
  );
}



