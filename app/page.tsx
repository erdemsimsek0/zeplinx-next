"use client";

import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";
import logo from "../zeplinx-logo.png";

const FILMS = [
  "Büyüleyici Çin",
  "Asya'ya Hoş Geldiniz",
  "Amerika Üzerinde Uçuş",
  "Hayvanlar Alemi Üzerinde Uçuş",
  "Perili Ev Üzerinde Uçuş",
  "Jurassic Dönemi Üzerinde Uçuş",
  "Dünya Üzerinde Uçuş",
] as const;

const OPEN_MINUTES = 10 * 60;
const LAST_START_MINUTES = 21 * 60 + 40;
const SLOT_MINUTES = 10;
const CAPACITY = 7;
const WINDOW_MINUTES = 120;
const WINDOW_SIZE = 6;

const STORAGE_KEY = "zeplin_x_state_customer_v1";
const BACKUP_KEY = "zeplin_x_state_customer_backup_v1";
const HISTORY_KEY = "zeplin_x_state_customer_history_v1";

const slotCount =
  Math.floor((LAST_START_MINUTES - OPEN_MINUTES) / SLOT_MINUTES) + 1;

type Session = {
  id: number;
  startMin: number;
  start: string;
  film: string;
  count: number;
};

type LogItem = {
  text: string;
  at: string;
};

type AppState = {
  day: string;
  sessions: Session[];
  logs: LogItem[];
  selectedFilm: string;
  viewStart: number;
};

type HistoryEntry = {
  at: number;
  state: AppState;
};

type SessionStatus = {
  label: string;
  cls: "closed" | "locked" | "full" | "running" | "open";
  locked: boolean;
};

const pad2 = (n: number) => String(n).padStart(2, "0");
const fromMinutes = (m: number) => `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
const todayIso = () => new Date().toISOString().slice(0, 10);
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function defaultState(): AppState {
  return {
    day: todayIso(),
    sessions: Array.from({ length: slotCount }, (_, i) => ({
      id: i,
      startMin: OPEN_MINUTES + i * SLOT_MINUTES,
      start: fromMinutes(OPEN_MINUTES + i * SLOT_MINUTES),
      film: FILMS[i % FILMS.length],
      count: 0,
    })),
    logs: [],
    selectedFilm: FILMS[0],
    viewStart: 0,
  };
}

function signature(snapshot: AppState) {
  return JSON.stringify({
    day: snapshot.day,
    sessions: snapshot.sessions.map((s) => [s.id, s.startMin, s.film, s.count]),
    logs: snapshot.logs.slice(0, 6).map((x) => [x.text, x.at]),
    selectedFilm: snapshot.selectedFilm,
    viewStart: snapshot.viewStart,
  });
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function hydrateState(parsed: Partial<AppState> | null): AppState {
  const fresh = defaultState();
  if (!parsed || parsed.day !== fresh.day) return fresh;

  fresh.sessions = fresh.sessions.map((session, index) => {
    const old = parsed.sessions?.[index];
    return old
      ? {
          ...session,
          ...old,
          id: index,
          startMin: session.startMin,
          start: session.start,
        }
      : session;
  });
  fresh.logs = Array.isArray(parsed.logs) ? parsed.logs.slice(0, 20) : [];
  fresh.selectedFilm =
    parsed.selectedFilm && FILMS.includes(parsed.selectedFilm as (typeof FILMS)[number])
      ? parsed.selectedFilm
      : FILMS[0];
  fresh.viewStart =
    typeof parsed.viewStart === "number" && Number.isInteger(parsed.viewStart)
      ? parsed.viewStart
      : 0;
  return fresh;
}

function loadInitialState(): AppState {
  if (typeof window === "undefined") return defaultState();

  const today = todayIso();
  let parsed = parseJson<AppState>(window.localStorage.getItem(STORAGE_KEY));

  if (!parsed || parsed.day !== today) {
    parsed = parseJson<AppState>(window.localStorage.getItem(BACKUP_KEY));
  }

  if (!parsed || parsed.day !== today) {
    const history = parseJson<HistoryEntry[]>(window.localStorage.getItem(HISTORY_KEY));
    if (Array.isArray(history) && history[0]?.state?.day === today) {
      parsed = history[0].state;
    }
  }

  return hydrateState(parsed);
}

function clampViewStart(value: number, total: number) {
  return Math.max(0, Math.min(value, Math.max(0, total - WINDOW_SIZE)));
}

function autoViewStart(nowMinutes: number, total: number) {
  let idx = Math.floor((nowMinutes - OPEN_MINUTES) / SLOT_MINUTES);
  if (nowMinutes < OPEN_MINUTES) idx = 0;
  if (nowMinutes > LAST_START_MINUTES) idx = total - WINDOW_SIZE;
  return clampViewStart(idx, total);
}

function getStatus(session: Session, nowMin: number): SessionStatus {
  const startMin = session.startMin;
  const endMin = startMin + SLOT_MINUTES;

  if (nowMin > endMin) return { label: "Geçti", cls: "closed", locked: true };
  if (startMin > nowMin + WINDOW_MINUTES) {
    return { label: "Kilitli", cls: "locked", locked: true };
  }
  if (session.count >= CAPACITY) return { label: "Dolu", cls: "full", locked: false };
  if (nowMin >= startMin && nowMin < endMin) {
    return { label: "Devam", cls: "running", locked: false };
  }
  if (startMin >= nowMin && startMin <= nowMin + WINDOW_MINUTES) {
    return { label: "Açık", cls: "open", locked: false };
  }
  return { label: "Kilitli", cls: "locked", locked: true };
}

export default function Home() {
  const [state, setState] = useState<AppState>(defaultState);
  const [ready, setReady] = useState(false);
  const [demoTimeMin, setDemoTimeMin] = useState<number | null>(null);
  const [currentMode, setCurrentMode] = useState<"cashier" | "customer">("cashier");
  const [activeSessionId, setActiveSessionId] = useState<number | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState("");
  const [toastVisible, setToastVisible] = useState(false);
  const [clockTick, setClockTick] = useState(Date.now());
  const undoStackRef = useRef<AppState[]>([]);
  const lastSignatureRef = useRef("");
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const loaded = loadInitialState();
    lastSignatureRef.current = signature(loaded);
    setState(loaded);
    setReady(true);
  }, []);

  const nowMinutes = useMemo(() => {
    if (demoTimeMin !== null) return demoTimeMin;
    const d = new Date(clockTick);
    return d.getHours() * 60 + d.getMinutes();
  }, [clockTick, demoTimeMin]);

  const nowTime = useMemo(() => {
    if (demoTimeMin !== null) return fromMinutes(demoTimeMin);
    const d = new Date(clockTick);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }, [clockTick, demoTimeMin]);

  useEffect(() => {
    const timer = window.setInterval(() => setClockTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!ready) return;

    const packed = JSON.stringify(state);
    window.localStorage.setItem(STORAGE_KEY, packed);
    window.localStorage.setItem(BACKUP_KEY, packed);

    const sig = signature(state);
    if (sig === lastSignatureRef.current) return;

    let hist = parseJson<HistoryEntry[]>(window.localStorage.getItem(HISTORY_KEY)) ?? [];
    hist.unshift({ at: Date.now(), state: clone(state) });
    hist = hist.slice(0, 8);
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(hist));
    lastSignatureRef.current = sig;
  }, [ready, state]);

  useEffect(() => {
    if (!ready) return;
    setState((current) => ({
      ...current,
      viewStart: autoViewStart(nowMinutes, current.sessions.length),
    }));
  }, [ready, nowMinutes]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setActiveSessionId(null);
        setHelpOpen(false);
        setSettingsOpen(false);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const showToast = (message: string) => {
    setToastMessage(message);
    setToastVisible(true);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToastVisible(false), 1600);
  };

  const pushUndo = () => {
    undoStackRef.current.push(clone(state));
    if (undoStackRef.current.length > 20) undoStackRef.current.shift();
  };

  const logAction = (text: string) => {
    setState((current) => ({
      ...current,
      logs: [{ text, at: nowTime }, ...current.logs].slice(0, 6),
    }));
  };

  const updateSession = (id: number, updater: (session: Session) => Session) => {
    setState((current) => ({
      ...current,
      sessions: current.sessions.map((session) =>
        session.id === id ? updater(session) : session,
      ),
    }));
  };

  const applyDemoTime = (mins: number | null) => {
    setDemoTimeMin(mins);
    showToast(mins === null ? "Gerçek saate dönüldü" : `Demo saat: ${fromMinutes(mins)}`);
  };

  const addPeople = (id: number, count: number) => {
    const session = state.sessions[id];
    if (!session) return;
    const status = getStatus(session, nowMinutes);
    if (status.locked || session.count >= CAPACITY) return;

    pushUndo();
    updateSession(id, (current) => ({
      ...current,
      count: Math.min(CAPACITY, current.count + count),
    }));
    showToast(`+${count} kişi eklendi`);
    logAction(`${session.start} seansına +${count} kişi eklendi`);
  };

  const removePeople = (id: number, count: number) => {
    const session = state.sessions[id];
    if (!session) return;
    const status = getStatus(session, nowMinutes);
    if (status.locked) return;

    pushUndo();
    updateSession(id, (current) => ({
      ...current,
      count: Math.max(0, current.count - count),
    }));
    showToast(`-${count} kişi çıkarıldı`);
    logAction(`${session.start} seansından -${count} kişi çıkarıldı`);
  };

  const assignFilm = (id: number, film: string) => {
    const session = state.sessions[id];
    if (!session) return;

    pushUndo();
    setState((current) => ({
      ...current,
      selectedFilm: film || current.selectedFilm,
      sessions: current.sessions.map((item) =>
        item.id === id ? { ...item, film } : item,
      ),
    }));
    setActiveSessionId(null);
    showToast("Film değişti");
    logAction(`${session.start} seansı film değişti: ${film || "Boş"}`);
  };

  const exportSummary = async () => {
    const lines = state.sessions
      .slice(0, 12)
      .map((session) => `${session.start} | ${session.film || "Film yok"} | ${session.count}/${CAPACITY}`);
    const text = `Zeplin X - Gün Özeti\n${lines.join("\n")}`;

    try {
      await navigator.clipboard.writeText(text);
      showToast("Özet kopyalandı");
      logAction("Özet panoya kopyalandı");
    } catch {
      window.alert(text);
    }
  };

  const restoreLatestBackup = () => {
    const history = parseJson<HistoryEntry[]>(window.localStorage.getItem(HISTORY_KEY)) ?? [];
    if (!history.length) {
      showToast("Geri yüklenecek yedek yok");
      return;
    }

    undoStackRef.current = [];
    setState(hydrateState(history[0].state));
    showToast("Son yedek geri yüklendi");
    setSettingsOpen(false);
  };

  const visibleStart = clampViewStart(state.viewStart, state.sessions.length);
  const visibleSessions = state.sessions.slice(visibleStart, visibleStart + WINDOW_SIZE);
  const customerSessions = state.sessions.filter(
    (session) =>
      session.startMin >= nowMinutes && session.startMin < nowMinutes + WINDOW_MINUTES,
  );

  const openCount = state.sessions.filter((session) => {
    const status = getStatus(session, nowMinutes);
    return (status.cls === "open" || status.cls === "running") && session.count < CAPACITY;
  }).length;
  const fullCount = state.sessions.filter((session) => session.count >= CAPACITY).length;
  const totalPeople = state.sessions.reduce((sum, session) => sum + session.count, 0);
  const bookableCount = customerSessions.filter((session) => {
    const status = getStatus(session, nowMinutes);
    return !status.locked && session.count < CAPACITY;
  }).length;
  const totalOpenSeats = customerSessions.reduce(
    (sum, session) => sum + Math.max(0, CAPACITY - session.count),
    0,
  );
  const activeSession = activeSessionId !== null ? state.sessions[activeSessionId] : null;

  return (
    <main className="page">
      <div className="gridBg" />
      <div className="wrap">
        <header className="topbar">
          <div className="brand">
            <div className="logo">
              <Image src={logo} alt="ZeplinX logosu" className="logoImage" priority />
            </div>
            <div>
              <h1>Zeplin X</h1>
              <p>Rezervasyon ve seans yönetimi</p>
            </div>
          </div>
          <div className="topbarActions">
            <button className="chip ghost compact" onClick={() => setSettingsOpen(true)}>
              ⚙ Ayarlar
            </button>
            <div className="clock">{nowTime}</div>
          </div>
        </header>

        <section className="hero">
          <div>
            <h2>Günlük Panel</h2>
            <div className="heroTime">{nowTime}</div>
            <div className="heroSub">
              Sadece önündeki 2 saatlik seanslar açıktır. Yazı yazmadan, sadece
              butonla çalışır. Demo saat ile gece test yapılır.
            </div>
            <div className="heroSub heroStatus">
              {demoTimeMin === null
                ? "Gerçek saat aktif"
                : `Demo saat aktif: ${fromMinutes(demoTimeMin)}`}
            </div>
          </div>
          <div className="stats">
            <div className="stat"><div className="v">{openCount}</div><div className="l">Açık</div></div>
            <div className="stat"><div className="v">{fullCount}</div><div className="l">Dolu</div></div>
            <div className="stat"><div className="v">{totalPeople}</div><div className="l">Toplam kişi</div></div>
          </div>
        </section>

        <div className="notice">
          <div><strong>Yeşil = açık</strong> <span>· Kırmızı = dolu · Gri = kilitli. Sadece açık saatleri kullan.</span></div>
          <div><span>Başlangıç: 10:00 · Son seans: 21:40</span></div>
        </div>

        <div className="toolbar">
          <div className="chiprow">
            <button
              className="chip primary"
              onClick={() =>
                setState((current) => ({
                  ...current,
                  viewStart: clampViewStart(current.viewStart - WINDOW_SIZE, current.sessions.length),
                }))
              }
            >
              ◀ Önceki 6
            </button>
            <button
              className="chip primary"
              onClick={() =>
                setState((current) => ({
                  ...current,
                  viewStart: clampViewStart(current.viewStart + WINDOW_SIZE, current.sessions.length),
                }))
              }
            >
              Sonraki 6 ▶
            </button>
            <button
              className="chip ghost"
              onClick={() =>
                setState((current) => ({
                  ...current,
                  viewStart: autoViewStart(nowMinutes, current.sessions.length),
                }))
              }
            >
              Şu ana dön
            </button>
          </div>
          <div className="chiprow">
            <button
              className={`chip ${currentMode === "cashier" ? "primary" : "ghost"}`}
              onClick={() => setCurrentMode("cashier")}
            >
              Kasiyer
            </button>
            <button
              className={`chip ${currentMode === "customer" ? "primary" : "ghost"}`}
              onClick={() => setCurrentMode("customer")}
            >
              Müşteri Ekranı
            </button>
          </div>
          <div className="chiprow">
            <button className="chip dark" onClick={() => setHelpOpen(true)}>Kullanım</button>
            <button className="chip ghost" onClick={exportSummary}>Özet Kopyala</button>
          </div>
        </div>

        {currentMode === "customer" ? (
          <CustomerView
            sessions={customerSessions}
            totalOpenSeats={totalOpenSeats}
            bookableCount={bookableCount}
            getStatus={(session) => getStatus(session, nowMinutes)}
          />
        ) : (
          <CashierView
            activeSessionId={activeSessionId}
            setActiveSessionId={setActiveSessionId}
            selectedFilm={state.selectedFilm}
            setSelectedFilm={(film) => setState((current) => ({ ...current, selectedFilm: film }))}
            sessions={visibleSessions}
            allSessions={state.sessions}
            visibleStart={visibleStart}
            logs={state.logs}
            addPeople={addPeople}
            removePeople={removePeople}
            assignFilm={assignFilm}
            getStatus={(session) => getStatus(session, nowMinutes)}
            undoLatest={() => {
              const previous = undoStackRef.current.pop();
              if (!previous) {
                showToast("Geri alınacak işlem yok");
                return;
              }
              setState(previous);
              showToast("Son işlem geri alındı");
            }}
          />
        )}
      </div>

      <FilmModal
        open={activeSessionId !== null}
        session={activeSession}
        onClose={() => setActiveSessionId(null)}
        onPick={(film) => activeSessionId !== null && assignFilm(activeSessionId, film)}
      />
      <HelpModal open={helpOpen} onClose={() => setHelpOpen(false)} />
      <SettingsModal
        open={settingsOpen}
        currentTime={demoTimeMin === null ? "Gerçek saat" : fromMinutes(demoTimeMin)}
        demoTimeMin={demoTimeMin}
        onClose={() => setSettingsOpen(false)}
        onRealTime={() => {
          applyDemoTime(null);
          setSettingsOpen(false);
        }}
        onPick={applyDemoTime}
        onRestore={restoreLatestBackup}
      />

      <div className={`toast ${toastVisible ? "show" : ""}`}>{toastMessage}</div>
    </main>
  );
}

function CustomerView({
  sessions,
  totalOpenSeats,
  bookableCount,
  getStatus,
}: {
  sessions: Session[];
  totalOpenSeats: number;
  bookableCount: number;
  getStatus: (session: Session) => SessionStatus;
}) {
  return (
    <section className="customerScreen">
      <div className="card customerShell">
        <div className="cardHd flush">
          <h3>Müşteri Ekranı</h3>
          <p>Hangi seanslarda kaç kişi var, hangi filmler var ve kaç kişi daha alınabilir net görünsün.</p>
        </div>
        <div className="customerSummaryGrid">
          <div className="customerSummary"><div className="v">{sessions.length}</div><div className="l">Gösterilen seans</div></div>
          <div className="customerSummary"><div className="v">{bookableCount}</div><div className="l">Katılınabilir</div></div>
          <div className="customerSummary"><div className="v">{totalOpenSeats}</div><div className="l">Toplam boş yer</div></div>
        </div>
        <div className="customerSessionsGrid">
          {sessions.length ? sessions.map((session) => {
            const status = getStatus(session);
            const remaining = Math.max(0, CAPACITY - session.count);

            return (
              <div className="customerCard" key={session.id}>
                <div className="title">{session.start} · {session.film || "Film seçilmedi"}</div>
                <div className="metaText">{session.count}/{CAPACITY} kişi dolu</div>
                <div className="line">
                  <span className={`pill ${status.locked ? "red" : "green"}`}>
                    {status.locked ? status.label : "Katılabilir"}
                  </span>
                  <span className="pill">{remaining} boş yer</span>
                </div>
                <div className="line">
                  <span className="pill">Seans süresi 10 dk</span>
                  <span className="pill">Müşteriye gösterilebilir</span>
                </div>
              </div>
            );
          }) : (
            <div className="customerCard empty">
              <div className="title">Şu an açık seans yok</div>
              <div className="metaText">Lütfen biraz sonra tekrar bakın.</div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function CashierView({
  activeSessionId,
  setActiveSessionId,
  selectedFilm,
  setSelectedFilm,
  sessions,
  allSessions,
  visibleStart,
  logs,
  addPeople,
  removePeople,
  assignFilm,
  getStatus,
  undoLatest,
}: {
  activeSessionId: number | null;
  setActiveSessionId: (id: number | null) => void;
  selectedFilm: string;
  setSelectedFilm: (film: string) => void;
  sessions: Session[];
  allSessions: Session[];
  visibleStart: number;
  logs: LogItem[];
  addPeople: (id: number, count: number) => void;
  removePeople: (id: number, count: number) => void;
  assignFilm: (id: number, film: string) => void;
  getStatus: (session: Session) => SessionStatus;
  undoLatest: () => void;
}) {
  return (
    <div className="panel">
      <section className="card">
        <div className="cardHd">
          <h3>Aktif Seanslar</h3>
          <p>Önümüzdeki 2 saat içindeki seanslar açık; uzak saatler kilitli görünür.</p>
        </div>
        <div className="sessions">
          {sessions.map((session, idx) => {
            const globalIndex = visibleStart + idx;
            const status = getStatus(session);
            const pct = Math.min(100, Math.round((session.count / CAPACITY) * 100));
            const fillClass = session.count >= CAPACITY ? "full" : pct >= 70 ? "warn" : "";

            return (
              <article
                className={`session ${status.cls} ${session.count >= CAPACITY ? "full" : ""} ${status.locked ? "locked" : ""} ${idx === 0 ? "upcoming" : ""}`}
                key={session.id}
              >
                <div className="sTop">
                  <div className="stime">{session.start}</div>
                  <div className={`badge ${status.cls}`}>{status.label}</div>
                </div>
                <div className="film">{session.film || "Film seçilmedi"}</div>
                <div className="meta">
                  <div className="bar"><div className={`fill ${fillClass}`} style={{ width: `${pct}%` }} /></div>
                  <div className="seats">{session.count}/{CAPACITY}</div>
                </div>
                <div className="btns">
                  <button className="btn add" disabled={status.locked || session.count >= CAPACITY} onClick={() => addPeople(globalIndex, 1)}>+1</button>
                  <button className="btn add2" disabled={status.locked || session.count >= CAPACITY} onClick={() => addPeople(globalIndex, 2)}>+2</button>
                  <button className="btn add3" disabled={status.locked || session.count >= CAPACITY} onClick={() => addPeople(globalIndex, 3)}>+3</button>
                  <button className="btn min" disabled={status.locked || session.count <= 0} onClick={() => removePeople(globalIndex, 1)}>-1</button>
                  <button className="btn filmBtn" onClick={() => setActiveSessionId(globalIndex)}>Film</button>
                  <button className="btn min mutedBtn" onClick={undoLatest}>Geri Al</button>
                </div>
                <div className="mini">
                  <span className="small">Saat: {session.start}</span>
                  <span className="small">Kalan: {Math.max(0, CAPACITY - session.count)}</span>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <aside className="side">
        <section className="card box">
          <div className="cardHd flush">
            <h3>Film Havuzu</h3>
            <p>Seanslara büyük ve okunaklı film kartlarıyla ata.</p>
          </div>
          <div className="filmgrid">
            {FILMS.map((film) => (
              <button
                className={`filmopt ${selectedFilm === film ? "active" : ""}`}
                key={film}
                onClick={() => {
                  setSelectedFilm(film);
                  if (activeSessionId !== null) {
                    assignFilm(activeSessionId, film);
                    return;
                  }
                  const firstOpen = allSessions.find(
                    (session) => !getStatus(session).locked && session.count < CAPACITY,
                  );
                  if (firstOpen) assignFilm(firstOpen.id, film);
                }}
              >
                {film}
              </button>
            ))}
          </div>
        </section>

        <section className="card box">
          <div className="cardHd flush">
            <h3>Durum</h3>
            <p>Bugünkü hızlı görünüm.</p>
          </div>
          <div className="legend">
            <div className="leg"><strong>Açık</strong><br /><span>Önümüzdeki 2 saat</span></div>
            <div className="leg"><strong>Dolu</strong><br /><span>7/7 olmuş</span></div>
            <div className="leg"><strong>Kilitli</strong><br /><span>Uzaktaki saatler</span></div>
            <div className="leg"><strong>Güvenli</strong><br /><span>Silme yok, sadece düzenle</span></div>
          </div>
        </section>

        <section className="card box">
          <div className="cardHd flush">
            <h3>Son Hareketler</h3>
            <p>Yaptığın işlemler burada görünür.</p>
          </div>
          <div className="history">
            {logs.length ? logs.map((item, index) => (
              <div className="log" key={`${item.at}-${index}`}>
                <div><strong>{item.text}</strong><br /><span>{item.at}</span></div>
                <span>✓</span>
              </div>
            )) : <div className="small">Henüz işlem yok.</div>}
          </div>
        </section>
      </aside>
    </div>
  );
}

function FilmModal({
  open,
  session,
  onClose,
  onPick,
}: {
  open: boolean;
  session: Session | null;
  onClose: () => void;
  onPick: (film: string) => void;
}) {
  return (
    <div className={`modal ${open ? "show" : ""}`} aria-hidden={!open} onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modalCard">
        <div className="modalHd">
          <h3>Film Seç</h3>
          <p>{session ? `${session.start} seansı için bir film ata.` : "Seans için bir film ata."}</p>
        </div>
        <div className="modalBody">
          <div className="pickrow">
            {FILMS.map((film) => (
              <button className={`pick ${session?.film === film ? "primary" : ""}`} key={film} onClick={() => onPick(film)}>
                {film}
              </button>
            ))}
          </div>
        </div>
        <div className="modalFt">
          <button className="btn min" onClick={onClose}>İptal</button>
          <button className="btn filmBtn" onClick={() => onPick("")}>Filmi Kaldır</button>
        </div>
      </div>
    </div>
  );
}

function HelpModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <div className={`modal ${open ? "show" : ""}`} aria-hidden={!open} onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modalCard">
        <div className="modalHd">
          <h3>Nasıl Kullanılır?</h3>
          <p>Bu ekran herkesin hızlı kullanımı için sade tutuldu.</p>
        </div>
        <div className="modalBody modalStack">
          <div className="leg helpItem"><strong>1. Kasiyer</strong><br /><span>Seans seç, film ata, kişi ekle veya çıkar.</span></div>
          <div className="leg helpItem"><strong>2. Müşteri Ekranı</strong><br /><span>Müşteriye boş yerleri ve uygun seansları göster.</span></div>
          <div className="leg helpItem"><strong>3. Kilitli saatler</strong><br /><span>Şu an alınmayan seanslardır, yanlışlıkla işlem yapılmaz.</span></div>
        </div>
        <div className="modalFt">
          <button className="btn filmBtn" onClick={onClose}>Tamam</button>
        </div>
      </div>
    </div>
  );
}

function SettingsModal({
  open,
  currentTime,
  demoTimeMin,
  onClose,
  onRealTime,
  onPick,
  onRestore,
}: {
  open: boolean;
  currentTime: string;
  demoTimeMin: number | null;
  onClose: () => void;
  onRealTime: () => void;
  onPick: (mins: number | null) => void;
  onRestore: () => void;
}) {
  const presets: Array<[string, number | null]> = [
    ["10:00", 10 * 60],
    ["12:00", 12 * 60],
    ["15:00", 15 * 60],
    ["18:00", 18 * 60],
    ["21:30", 21 * 60 + 30],
    ["Gerçek Saat", null],
  ];

  return (
    <div className={`modal ${open ? "show" : ""}`} aria-hidden={!open} onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modalCard">
        <div className="modalHd">
          <h3>Ayarlar</h3>
          <p>Test saati ve temel kullanım seçenekleri burada.</p>
        </div>
        <div className="modalBody modalStack">
          <div className="leg helpItem"><strong>Aktif Saat</strong><br /><span>{currentTime}</span></div>
          <div className="leg helpItem"><strong>Test Modu</strong><br /><span>Gece bile seansları görmek için demo saat seç.</span></div>
          <div className="pickrow twoCols">
            {presets.map(([label, mins]) => (
              <button className={`pick ${demoTimeMin === mins ? "primary" : ""}`} key={label} onClick={() => onPick(mins)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="modalFt">
          <button className="btn min" onClick={onClose}>Kapat</button>
          <button className="btn filmBtn" onClick={onRealTime}>Gerçek Saat</button>
          <button className="btn min" onClick={onRestore}>Yedeği Yükle</button>
        </div>
      </div>
    </div>
  );
}
