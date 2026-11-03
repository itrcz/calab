'use client';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { Locale } from '@/i18n';
import { fitCardShift } from '@/lib/card-viewport';
import { CardStickers } from './card-stickers';
import { accented } from './ui';

// Six scenarios (§4.8): «remote» and «pair work» repeated the others and were dropped.
const scenarios = ['meetings', 'learning', 'design', 'support', 'planning', 'onboarding'];
const COUNT = scenarios.length;
const copy = {
  ru: { title: 'Одна команда. Разные задачи.', accent: 'Разные задачи.', note: 'Calab — для каждого рабочего сценария.', places: ['Совещания', 'Обучение', 'Дизайн-ревью', 'Поддержка', 'Планирование', 'Онбординг', 'Удалёнка', 'Парная работа'], details: ['Обсудить планы и решения', 'Показать, объяснить, научить', 'Разобрать макет вместе', 'Помочь голосом и экраном', 'От идей к задачам', 'Ввести новичка в курс дела', 'Быть рядом из любой точки', 'Решить сложное вдвоём'] },
  en: { title: 'One team. Many ways to work.', accent: 'Many ways to work.', note: 'Calab fits the way you work together.', places: ['Meetings', 'Learning', 'Design reviews', 'Support', 'Planning', 'Onboarding', 'Remote work', 'Pair work'], details: ['Discuss plans and decisions', 'Show, explain and teach', 'Review a design together', 'Help with voice and screen sharing', 'From ideas to tasks', 'Get new teammates up to speed', 'Connect from anywhere', 'Solve the hard parts together'] },
  es: { title: 'Un equipo. Muchas formas de trabajar.', accent: 'Muchas formas de trabajar.', note: 'Calab se adapta a tu trabajo en equipo.', places: ['Reuniones', 'Formación', 'Revisar diseños', 'Soporte', 'Planificación', 'Incorporación', 'Trabajo remoto', 'En pareja'], details: ['Compartir planes y decisiones', 'Mostrar, explicar y enseñar', 'Revisar un diseño juntos', 'Ayudar con voz y pantalla', 'De las ideas a las tareas', 'Dar la bienvenida al equipo', 'Conectar desde cualquier lugar', 'Resolver lo difícil juntos'] },
  zh: { title: '一个团队，多种协作方式。', accent: '多种协作方式。', note: 'Calab，适合每一种工作场景。', places: ['团队会议', '学习培训', '设计评审', '客户支持', '项目规划', '新人入职', '远程办公', '结对协作'], details: ['讨论计划与决策', '演示、讲解与学习', '一起审阅设计', '通过语音和共享屏幕提供帮助', '从想法到任务', '帮助新同事融入团队', '随时随地保持联系', '一起解决难题'] },
};

export function ConferenceStrip({ locale, cta }: { locale: Locale; cta?: ReactNode }) {
  const t = copy[locale];
  const viewport = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const pointer = useRef({ x: -1, y: -1 });
  const live = useRef({ active: null as number | null, shift: 0 });
  const [view, setView] = useState({ active: null as number | null, shift: 0, scale: 1.13 });
  const activate = (index: number) => {
    const area = viewport.current; const row = track.current;
    const slot = row?.children[index] as HTMLElement | undefined;
    if (!area || !row || !slot) return;
    const padding = 24;
    const scale = Math.min(1.13, (area.clientWidth - padding * 2) / slot.offsetWidth);
    const mobile = window.matchMedia('(max-width: 639px)').matches;
    let shift = 0;
    if (mobile) {
      const rowStart = row.getBoundingClientRect().left - area.getBoundingClientRect().left + area.scrollLeft;
      const center = rowStart + slot.offsetLeft + slot.offsetWidth / 2;
      const target = fitCardShift(center, slot.offsetWidth * scale, area.clientWidth, -area.scrollLeft, padding);
      area.scrollTo({ left: -target, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    } else {
      const center = (area.clientWidth - row.offsetWidth) / 2 + slot.offsetLeft + slot.offsetWidth / 2;
      shift = fitCardShift(center, slot.offsetWidth * scale, area.clientWidth, live.current.shift, padding);
    }
    live.current = { active: index, shift };
    setView({ active: index, shift, scale });
  };
  const reset = () => {
    live.current = { active: null, shift: 0 };
    pointer.current = { x: -1, y: -1 };
    setView({ active: null, shift: 0, scale: 1.13 });
  };
  useEffect(() => {
    // A viewport change invalidates the previous containment calculation.
    const resize = () => { live.current = { active: null, shift: 0 }; setView({ active: null, shift: 0, scale: 1.13 }); };
    window.addEventListener('resize', resize);
    return () => { window.removeEventListener('resize', resize); };
  }, []);
  return <section className="conference-section section-quiet" aria-labelledby="conference-title">
    <div className="conference-heading" data-reveal><h2 id="conference-title" className="h2">{accented(t.title, t.accent)}</h2><p className="lead">{t.note}</p></div>
    <div ref={viewport} className="conference-scroll" role="region" aria-label={t.title}
      onPointerLeave={() => { if (!viewport.current?.contains(document.activeElement)) reset(); }}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) reset(); }}
      onPointerMove={(event) => {
        if (event.pointerType !== 'mouse') return;
        // Layout movement must not generate a new selection under a stationary pointer.
        if (Math.hypot(event.clientX - pointer.current.x, event.clientY - pointer.current.y) < 3) return;
        pointer.current = { x: event.clientX, y: event.clientY };
        const current = live.current.active;
        const face = current === null ? null : track.current?.children[current]?.querySelector('.conference-card');
        const box = face?.getBoundingClientRect();
        if (box && event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom) return;
        // Pick the visible face, including the part extending beyond its layout slot.
        const slots = Array.from(track.current?.children ?? []);
        for (let index = slots.length - 1; index >= 0; index--) {
          const bounds = slots[index]?.querySelector('.conference-card')?.getBoundingClientRect();
          if (bounds && event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom) {
            if (index !== current) activate(index);
            break;
          }
        }
      }}>
      <div ref={track} className="conference-row" style={{ '--track-shift': `${view.shift}px` } as CSSProperties}>
        {t.places.slice(0, COUNT).map((place, index) => <button type="button" data-card-index={index} key={place} className="conference-person" aria-pressed={view.active === index}
          onFocus={() => { activate(index); }} onClick={() => { activate(index); }}
          style={{ '--spread': view.active === null ? '0px' : index < view.active ? '-38px' : index > view.active ? '38px' : '0px', '--card-scale': view.active === index ? view.scale : 1, '--card-lift': view.active === index ? '-18px' : '0px', '--card-angle': view.active === index ? '0deg' : `${[-4, 2, 5][index % 3]}deg`, zIndex: view.active === index ? 9 : 1 } as CSSProperties}>
          <span className="conference-card">
            <CardStickers active={view.active === index} />
            <span className="photo-card-surface">
            <img className="conference-photo" src={`/editorial/usecase-${scenarios[index]}.webp`} width={600} height={750} alt="" loading="lazy" />
            <span className="conference-person-caption">{place}<span className="conference-scenario-detail">{t.details[index]}</span></span>
            </span>
          </span>
        </button>)}
      </div>
    </div>
    {cta && <div className="wrap">{cta}</div>}
  </section>;
}
