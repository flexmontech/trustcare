import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import type { FormEvent } from "react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Trust Care Agency — Home Care in Chicago & the Suburbs" },
      {
        name: "description",
        content:
          "Compassionate home care for seniors and families across Chicago, Chicagoland, and the surrounding suburbs: companion care, personal care, dementia support, respite care, and post-hospital recovery.",
      },
    ],
  }),
  component: Home,
});

function CheckIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className={className} aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M16.704 4.153a.75.75 0 0 1 .143 1.052l-8 10.5a.75.75 0 0 1-1.127.075l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 0 1 1.05-.143Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

const SERVICES = [
  {
    title: "Companion care",
    description:
      "Friendly conversation, outings, and a reassuring daily presence — helping your loved one stay engaged, connected, and at ease at home.",
  },
  {
    title: "Personal care",
    description:
      "Hands-on help with daily activities like bathing, dressing, grooming, and mobility — delivered with patience, dignity, and respect.",
  },
  {
    title: "Dementia & Alzheimer's care",
    description:
      "Calm, consistent caregivers trained to support people living with memory loss — with routines and approaches that reduce confusion and anxiety.",
  },
  {
    title: "Respite care",
    description:
      "A trusted caregiver steps in so family caregivers can rest, run errands, or take a break — knowing Mom or Dad is in good hands.",
  },
  {
    title: "Post-hospital recovery support",
    description:
      "Help bouncing back after a surgery, illness, or hospital stay — including meal preparation, medication reminders, and light assistance at home.",
  },
];

const COVERAGE_AREAS = [
  "Evanston",
  "Oak Park",
  "Skokie",
  "Naperville",
  "Bolingbrook",
  "Lombard",
];

const WHY_CHOOSE = [
  {
    title: "Friendly, vetted caregivers",
    description:
      "We take the time to get to know the people on our team — background-checked, interviewed, and matched to your family's needs and personality.",
  },
  {
    title: "Personalized care plans",
    description:
      "No cookie-cutter visits. We build a care plan around your loved one's routines, preferences, and goals — and adjust it as needs change.",
  },
  {
    title: "Family communication",
    description:
      "You'll hear from us. Regular updates after visits and an easy way to reach our local team whenever you have questions or concerns.",
  },
  {
    title: "A local team",
    description:
      "We're based in and around Chicago — a local team that knows the neighborhoods and communities we serve, not a distant call center.",
  },
];

const CARE_OPTIONS = [
  "Companion Care",
  "Personal Care",
  "Dementia Care",
  "Respite Care",
  "Post-Hospital Support",
  "Other",
];

type FormState = {
  fullName: string;
  phone: string;
  email: string;
  careNeeded: string;
  cityZip: string;
  message: string;
};

const EMPTY_FORM: FormState = {
  fullName: "",
  phone: "",
  email: "",
  careNeeded: "",
  cityZip: "",
  message: "",
};

function Home() {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const setField = (field: keyof FormState, value: string) => {
    setForm((f) => ({ ...f, [field]: value }));
    setErrors((e) => ({ ...e, [field]: undefined }));
  };

  function validate(): Partial<Record<keyof FormState, string>> {
    const e: Partial<Record<keyof FormState, string>> = {};
    if (!form.fullName.trim()) e.fullName = "Please enter your full name.";
    const phoneDigits = form.phone.replace(/\D/g, "");
    if (!form.phone.trim()) e.phone = "Please enter a phone number.";
    else if (phoneDigits.length < 7 || phoneDigits.length > 15)
      e.phone = "Please enter a valid phone number.";
    if (!form.email.trim()) e.email = "Please enter your email address.";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(form.email.trim()))
      e.email = "Please enter a valid email address.";
    if (!form.careNeeded) e.careNeeded = "Please choose the type of care you're looking for.";
    if (!form.cityZip.trim()) e.cityZip = "Please enter your city or ZIP code.";
    return e;
  }

  async function handleSubmit(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    setSubmitError(null);
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length > 0) return;

    setSubmitting(true);
    try {
      const fullName = form.fullName.trim();
      // Split "Evanston 60201" / "60201" into city + zip where possible.
      const raw = form.cityZip.trim();
      const zipMatch = raw.match(/^(.*?)\s*(\d{5}(?:-\d{4})?)$/);
      const city = zipMatch && zipMatch[1].trim() ? zipMatch[1].trim() : raw;
      const zip = zipMatch && zipMatch[1].trim() ? zipMatch[2] : null;

      const res = await fetch("/api/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          company_name: `${fullName} — Web Inquiry`,
          contact_name: fullName,
          email: form.email.trim(),
          phone: form.phone.trim(),
          city,
          zip,
          lead_type: form.careNeeded
            ? `Home Care — ${form.careNeeded}`
            : "Home Care — Inquiry",
          notes: form.message.trim() || null,
        }),
      });
      if (!res.ok) {
        throw new Error("Request failed");
      }
      setSubmitted(true);
      setForm(EMPTY_FORM);
    } catch {
      setSubmitError(
        "Something went wrong — please try again in a moment. You can also call us at (815) 260-3106.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  const inputCls =
    "w-full rounded-lg border border-neutral-300 bg-[#EFF3F8] px-3.5 py-2.5 text-base text-[#161616] placeholder:text-neutral-400 focus:border-[#161616] focus:outline-none focus:ring-2 focus:ring-[#161616]/20";
  const labelCls = "mb-1.5 block text-sm font-semibold text-[#161616]";

  return (
    <main className="min-h-dvh bg-[#E6ECF4] text-[#161616]">
      {/* ───────────────── Header ───────────────── */}
      <header className="sticky top-0 z-20 border-b border-white/10 bg-[#404040]/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <a href="#top" className="flex items-center gap-2.5">
            <img
              src="/trustcare-logo.png"
              alt="Trust Care Agency logo"
              className="h-10 w-auto rounded-md bg-[#EFF3F8] p-1"
            />
            <span className="whitespace-nowrap text-base font-bold tracking-tight text-white sm:text-xl">
              Trust Care Agency
            </span>
          </a>
          <nav className="hidden items-center gap-6 text-sm font-medium text-neutral-300 sm:flex">
            <a href="#services" className="hover:text-white">Services</a>
            <a href="#coverage" className="hover:text-white">Coverage</a>
            <a href="#contact" className="hover:text-white">Contact</a>
          </nav>
          <a
            href="#contact"
            className="hidden rounded-full bg-[#D8E4F2] px-5 py-2 text-sm font-semibold text-[#161616] shadow-md shadow-black/25 hover:bg-[#E9F0F9] sm:inline-flex"
          >
            Request care
          </a>
          <a
            href="#contact"
            className="rounded-full bg-[#D8E4F2] px-4 py-2 text-sm font-semibold text-[#161616] hover:bg-[#E9F0F9] sm:hidden"
          >
            Contact
          </a>
        </div>
      </header>

      {/* ───────────────── Hero ───────────────── */}
      <section
        id="top"
        className="relative overflow-hidden bg-gradient-to-br from-[#4d4d4d] via-[#424242] to-[#383838]"
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -left-24 -top-24 h-80 w-80 rounded-full bg-[#D8E4F2]/10 blur-3xl"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-20 top-44 h-72 w-72 rounded-full bg-amber-400/25 blur-3xl"
        />
        <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-4 pb-16 pt-10 sm:px-6 sm:pt-14 lg:grid-cols-2 lg:gap-12">
          {/* Left — copy */}
          <div className="text-center lg:text-left">
            <span className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-[#EFF3F8]/10 px-4 py-1.5 text-sm font-semibold text-white backdrop-blur">
              <span className="h-2 w-2 rounded-full bg-amber-400" aria-hidden="true" />
              Serving Chicago · Chicagoland &amp; the suburbs
            </span>
            <h1 className="mt-5 text-4xl font-extrabold leading-tight tracking-tight text-white sm:text-5xl">
              Compassionate home care for{" "}
              <span className="bg-gradient-to-r from-[#D8E4F2] via-[#EFF5FB] to-[#c8b57f] bg-clip-text text-transparent">
                seniors and families
              </span>{" "}
              across Chicago
            </h1>
            <p className="mx-auto mt-5 max-w-xl text-lg leading-relaxed text-neutral-300 lg:mx-0">
              Trust Care Agency connects Chicago, Chicagoland, and the surrounding
              suburbs with friendly, dependable caregivers — help with daily activities,
              dementia support, respite relief, and recovery after a hospital stay,
              right at home.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row lg:justify-start">
              <a
                href="#contact"
                className="w-full rounded-full bg-[#D8E4F2] px-8 py-3.5 text-lg font-semibold text-[#161616] shadow-lg shadow-black/25 hover:bg-[#E9F0F9] sm:w-auto"
              >
                Request care information
              </a>
              <a
                href="#services"
                className="w-full rounded-full border border-white/25 bg-[#EFF3F8]/10 px-8 py-3.5 text-lg font-semibold text-white hover:bg-[#E9F0F9]/20 sm:w-auto"
              >
                See how we help
              </a>
              <a
                href="tel:+18152603106"
                className="w-full whitespace-nowrap rounded-full border border-amber-400/60 bg-amber-400/10 px-6 py-3.5 text-lg font-semibold text-white hover:bg-amber-400/20 sm:w-auto"
              >
                Call (815) 260-3106
              </a>
            </div>
            <ul className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm font-semibold text-neutral-300 lg:justify-start">
              <li className="flex items-center gap-1.5">
                <CheckIcon className="h-4 w-4 text-amber-400" />
                Background-checked caregivers
              </li>
              <li className="flex items-center gap-1.5">
                <CheckIcon className="h-4 w-4 text-amber-400" />
                24/7 availability
              </li>
              <li className="flex items-center gap-1.5">
                <CheckIcon className="h-4 w-4 text-amber-400" />
                Matched to your family
              </li>
            </ul>
          </div>

          {/* Right — photo */}
          <div className="relative mx-auto w-full max-w-lg">
            <div
              aria-hidden="true"
              className="absolute -inset-3 rotate-2 rounded-3xl bg-gradient-to-br from-[#D8E4F2]/60 via-[#EFF5FB]/40 to-[#c8b57f]/40"
            />
            <img
              src="/hero-senior-care.jpg"
              alt="A caring aide visiting with senior patients in a warm home setting"
              width={600}
              height={400}
              className="relative aspect-[4/3] w-full rounded-3xl border-4 border-white object-cover shadow-2xl"
            />
            <div className="absolute -left-3 top-6 flex items-center gap-2 rounded-2xl bg-[#F5F8FC]/95 px-4 py-3 shadow-lg ring-1 ring-neutral-200 sm:-left-6">
              <span
                aria-hidden="true"
                className="flex h-9 w-9 items-center justify-center rounded-full bg-[#D8E4F2] text-lg text-[#161616]"
              >
                ♥
              </span>
              <div>
                <p className="text-sm font-bold text-[#161616]">Compassionate care</p>
                <p className="text-xs text-neutral-500">Background-checked aides</p>
              </div>
            </div>
            <div className="absolute -bottom-4 right-4 flex items-center gap-2 rounded-2xl bg-[#F5F8FC]/95 px-4 py-3 shadow-lg ring-1 ring-neutral-200">
              <span className="relative flex h-3 w-3" aria-hidden="true">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
                <span className="relative inline-flex h-3 w-3 rounded-full bg-amber-500" />
              </span>
              <div>
                <p className="text-sm font-bold text-[#161616]">Available 24/7</p>
                <p className="text-xs text-neutral-500">Care when you need it</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ───────────────── Services ───────────────── */}
      <section id="services" className="border-t border-neutral-200 bg-[#EFF3F8] py-14">
        <div className="mx-auto max-w-5xl px-4 sm:px-6">
          <h2 className="text-center text-2xl font-bold tracking-tight text-[#161616] sm:text-3xl">
            Care that meets your loved one where they are
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-center text-lg text-neutral-600">
            Every family's situation is different. Here are the kinds of support our
            caregivers provide:
          </p>
          <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {SERVICES.map((s) => (
              <div
                key={s.title}
                className="rounded-2xl border border-neutral-200 bg-[#E4EAF3] p-6 shadow-sm"
              >
                <div
                  className="mb-3 h-1.5 w-10 rounded-full bg-gradient-to-r from-[#525252] to-[#c8b57f]"
                  aria-hidden="true"
                />
                <h3 className="text-lg font-semibold text-[#2b2b2b]">{s.title}</h3>
                <p className="mt-2 leading-relaxed text-neutral-600">{s.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ───────────────── Coverage ───────────────── */}
      <section id="coverage" className="border-t border-neutral-200 bg-[#E3EAF4] py-14">
        <div className="mx-auto max-w-5xl px-4 sm:px-6">
          <h2 className="text-center text-2xl font-bold tracking-tight text-[#161616] sm:text-3xl">
            Proudly serving Chicago and the surrounding suburbs
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-center text-lg text-neutral-600">
            We provide care throughout Chicagoland — in the city and in nearby
            communities, including:
          </p>
          <ul className="mt-8 flex flex-wrap justify-center gap-3">
            {COVERAGE_AREAS.map((area) => (
              <li
                key={area}
                className="rounded-full border border-neutral-200 bg-[#EFF3F8] px-5 py-2 text-base font-medium text-[#2b2b2b]"
              >
                {area}
              </li>
            ))}
            <li className="rounded-full border border-neutral-200 bg-[#EFF3F8] px-5 py-2 text-base font-medium text-[#2b2b2b]">
              …and communities across the area
            </li>
          </ul>
          <p className="mx-auto mt-6 max-w-2xl text-center text-neutral-600">
            Not sure if we cover your neighborhood? Reach out — we'll be glad to let
            you know.
          </p>
        </div>
      </section>

      {/* ───────────────── Why families choose us ───────────────── */}
      <section className="border-t border-neutral-200 bg-[#EFF3F8] py-14">
        <div className="mx-auto max-w-5xl px-4 sm:px-6">
          <h2 className="text-center text-2xl font-bold tracking-tight text-[#161616] sm:text-3xl">
            Why families choose Trust Care Agency
          </h2>
          <div className="mt-10 grid gap-6 sm:grid-cols-2">
            {WHY_CHOOSE.map((w) => (
              <div key={w.title} className="rounded-2xl border border-neutral-200 bg-[#E4EAF3] p-6">
                <div className="flex items-start gap-4">
                  <span
                    aria-hidden="true"
                    className="mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#404040] to-[#6b6b6b] text-white"
                  >
                    <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
                      <path
                        fillRule="evenodd"
                        d="M16.704 4.153a.75.75 0 0 1 .143 1.052l-8 10.5a.75.75 0 0 1-1.127.075l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 0 1 1.05-.143Z"
                        clipRule="evenodd"
                      />
                    </svg>
                  </span>
                  <div>
                    <h3 className="text-lg font-semibold text-[#2b2b2b]">{w.title}</h3>
                    <p className="mt-1.5 leading-relaxed text-neutral-600">{w.description}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ───────────────── Lead capture form ───────────────── */}
      <section id="contact" className="border-t border-neutral-200 bg-[#E3EAF4] py-14">
        <div className="mx-auto max-w-3xl px-4 sm:px-6">
          <h2 className="text-center text-2xl font-bold tracking-tight text-[#161616] sm:text-3xl">
            Let's talk about care for your family
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-center text-lg text-neutral-600">
            Tell us a little about what you need and we'll be in touch shortly. No
            obligation — just a conversation.
          </p>
          <p className="mx-auto mt-4 text-center text-base text-neutral-700">
            Prefer to talk? Call{" "}
            <a
              href="tel:+18152603106"
              className="font-semibold text-[#161616] underline decoration-amber-400 underline-offset-4"
            >
              (815) 260-3106
            </a>
            {" · "}
            <a
              href="mailto:trustcare@mail.com"
              className="font-semibold text-[#161616] underline decoration-amber-400 underline-offset-4"
            >
              trustcare@mail.com
            </a>
            {" · "}
            <a
              href="https://www.trustcareagency.net"
              className="font-semibold text-[#161616] underline decoration-amber-400 underline-offset-4"
            >
              www.trustcareagency.net
            </a>
          </p>

          {submitted ? (
            <div
              role="status"
              className="mt-10 rounded-2xl border border-neutral-200 bg-[#EFF3F8] p-8 text-center shadow-sm"
            >
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-[#D8E4F2]">
                <svg viewBox="0 0 20 20" fill="currentColor" className="h-8 w-8 text-[#161616]">
                  <path
                    fillRule="evenodd"
                    d="M16.704 4.153a.75.75 0 0 1 .143 1.052l-8 10.5a.75.75 0 0 1-1.127.075l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 0 1 1.05-.143Z"
                    clipRule="evenodd"
                  />
                </svg>
              </div>
              <h3 className="text-xl font-bold text-[#161616]">
                Thank you — we'll be in touch shortly
              </h3>
              <p className="mt-2 text-neutral-600">
                Your request has been received. A member of our local team will reach
                out soon. If it's urgent, call us at (815) 260-3106.
              </p>
              <button
                onClick={() => setSubmitted(false)}
                className="mt-6 rounded-full border border-neutral-300 bg-[#EFF3F8] px-6 py-2.5 text-base font-semibold text-[#2b2b2b] hover:bg-[#D8E4F2]"
              >
                Send another request
              </button>
            </div>
          ) : (
            <form
              onSubmit={handleSubmit}
              noValidate
              className="mt-10 rounded-2xl border border-neutral-200 bg-[#EFF3F8] p-6 shadow-sm sm:p-8"
            >
              <div className="grid gap-5 sm:grid-cols-2">
                <div className="sm:col-span-1">
                  <label htmlFor="fullName" className={labelCls}>
                    Full name <span className="text-rose-500" aria-hidden="true">*</span>
                  </label>
                  <input
                    id="fullName"
                    name="fullName"
                    type="text"
                    autoComplete="name"
                    value={form.fullName}
                    onChange={(e) => setField("fullName", e.target.value)}
                    placeholder="Jane Smith"
                    className={inputCls}
                  />
                  {errors.fullName && (
                    <p className="mt-1.5 text-sm font-medium text-rose-600">{errors.fullName}</p>
                  )}
                </div>
                <div className="sm:col-span-1">
                  <label htmlFor="phone" className={labelCls}>
                    Phone <span className="text-rose-500" aria-hidden="true">*</span>
                  </label>
                  <input
                    id="phone"
                    name="phone"
                    type="tel"
                    autoComplete="tel"
                    value={form.phone}
                    onChange={(e) => setField("phone", e.target.value)}
                    placeholder="(312) 555-0123"
                    className={inputCls}
                  />
                  {errors.phone && (
                    <p className="mt-1.5 text-sm font-medium text-rose-600">{errors.phone}</p>
                  )}
                </div>
                <div className="sm:col-span-1">
                  <label htmlFor="email" className={labelCls}>
                    Email <span className="text-rose-500" aria-hidden="true">*</span>
                  </label>
                  <input
                    id="email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    value={form.email}
                    onChange={(e) => setField("email", e.target.value)}
                    placeholder="jane@example.com"
                    className={inputCls}
                  />
                  {errors.email && (
                    <p className="mt-1.5 text-sm font-medium text-rose-600">{errors.email}</p>
                  )}
                </div>
                <div className="sm:col-span-1">
                  <label htmlFor="careNeeded" className={labelCls}>
                    Care needed <span className="text-rose-500" aria-hidden="true">*</span>
                  </label>
                  <select
                    id="careNeeded"
                    name="careNeeded"
                    value={form.careNeeded}
                    onChange={(e) => setField("careNeeded", e.target.value)}
                    className={inputCls}
                  >
                    <option value="">Choose a type of care…</option>
                    {CARE_OPTIONS.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  {errors.careNeeded && (
                    <p className="mt-1.5 text-sm font-medium text-rose-600">{errors.careNeeded}</p>
                  )}
                </div>
                <div className="sm:col-span-2">
                  <label htmlFor="cityZip" className={labelCls}>
                    City / ZIP <span className="text-rose-500" aria-hidden="true">*</span>
                  </label>
                  <input
                    id="cityZip"
                    name="cityZip"
                    type="text"
                    autoComplete="postal-code"
                    value={form.cityZip}
                    onChange={(e) => setField("cityZip", e.target.value)}
                    placeholder="Evanston, 60201"
                    className={inputCls}
                  />
                  {errors.cityZip && (
                    <p className="mt-1.5 text-sm font-medium text-rose-600">{errors.cityZip}</p>
                  )}
                </div>
                <div className="sm:col-span-2">
                  <label htmlFor="message" className={labelCls}>
                    Message <span className="font-normal text-neutral-500">(optional)</span>
                  </label>
                  <textarea
                    id="message"
                    name="message"
                    rows={4}
                    value={form.message}
                    onChange={(e) => setField("message", e.target.value)}
                    placeholder="Tell us a little about your loved one and what you're looking for…"
                    className={inputCls}
                  />
                </div>
              </div>

              {submitError && (
                <p
                  role="alert"
                  className="mt-5 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-base text-rose-700"
                >
                  {submitError}
                </p>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="mt-6 w-full rounded-full bg-[#404040] px-8 py-3.5 text-lg font-semibold text-white shadow-lg shadow-black/25 hover:bg-[#525252] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? "Sending…" : "Request a call back"}
              </button>
              <p className="mt-3 text-center text-sm text-neutral-500">
                We'll only use your details to respond to this request. No spam, ever.
              </p>
            </form>
          )}
        </div>
      </section>

      {/* ───────────────── Footer ───────────────── */}
      <footer className="border-t border-white/10 bg-[#404040] py-10">
        <div className="mx-auto flex max-w-5xl flex-col items-center gap-6 px-4 text-center sm:px-6 md:flex-row md:justify-between md:text-left">
          <div>
            <p className="text-lg font-bold text-white">Trust Care Agency</p>
            <p className="mt-1 text-neutral-400">
              Home care for seniors and families across Chicagoland
            </p>
            <p className="mt-2 text-neutral-400">
              Call 24/7:{" "}
              <a
                href="tel:+18152603106"
                className="font-semibold text-white hover:text-amber-300"
              >
                (815) 260-3106
              </a>
            </p>
            <p className="mt-1 text-neutral-400">
              <a href="mailto:trustcare@mail.com" className="hover:text-white">
                trustcare@mail.com
              </a>
              {" · "}
              <a
                href="https://www.trustcareagency.net"
                className="hover:text-white"
              >
                www.trustcareagency.net
              </a>
            </p>
          </div>
          <nav className="flex flex-col items-center gap-3 text-neutral-300 md:items-end">
            <a href="#services" className="hover:text-white">Services</a>
            <a href="#coverage" className="hover:text-white">Coverage</a>
            <a href="#contact" className="hover:text-white">Contact us</a>
          </nav>
        </div>
        <p className="mt-8 text-center text-sm text-neutral-500">
          © {new Date().getFullYear()} Trust Care Agency. All rights reserved.
        </p>
        <p className="mt-3 text-center text-xs font-medium text-neutral-500">
          <a href="/dashboard" className="hover:text-white">Team workspace</a>
          {" · "}
          <a href="/leads" className="hover:text-white">Leads list</a>
        </p>
      </footer>
    </main>
  );
}