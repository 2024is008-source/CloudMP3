import { createFileRoute } from "@tanstack/react-router";

import { LegalPage, LegalSection } from "@/components/Page";
import { SITE } from "@/lib/site";
import { seoHead } from "@/lib/seo";

export const Route = createFileRoute("/privacy")({
  head: () =>
    seoHead({
      title: `Privacy Policy — ${SITE.name}`,
      description: `${SITE.name} keeps no accounts, no copies of your files and no history tied to you. Read exactly what is and is not stored, including what our analytics tag measures.`,
      path: "/privacy",
      ogType: "article",
    }),
  component: Privacy,
});

function Privacy() {
  return (
    <LegalPage
      title="Privacy Policy"
      updated="3 November 2026"
      intro={`This policy explains what ${SITE.name} (${SITE.domain}) collects when you use the Service. The short version: we do not build a profile of you.`}
    >
      <LegalSection heading="1. Data collection">
        <p>
          The Service does not store your search history, the links you paste, the tracks you fetch,
          or your downloaded audio. There are no user accounts and no profiles, so there is no
          history to keep. Section 3 describes the aggregate usage measurement we do run.
        </p>
        <p>
          The link you paste is sent to our server only to ask SoundCloud what it refers to and to
          locate the audio stream. That request is used for the single fetch you asked for and is
          not written to a database tied to you.
        </p>
      </LegalSection>

      <LegalSection heading="2. Temporary file retention">
        <p>
          A file SoundCloud already serves in the form you asked for is proxied through the Service
          in memory and streamed straight to your browser. Where audio has to be converted, or a
          playlist packed into a ZIP, the work is done in isolated scratch space on the server and
          discarded as soon as the transfer to your browser finishes or you leave the page. Nothing
          is kept on our servers afterwards, and we cannot retrieve a file you have already
          downloaded.
        </p>
      </LegalSection>

      <LegalSection heading="3. Cookies, analytics and security headers">
        <p>
          The Service does not set advertising cookies of its own. Standard web-traffic data (such
          as request metadata needed to serve the page and block abuse) may be recorded by the
          hosting platform for security and reliability. We do not sell or rent personal data, and
          we do not run advertising or remarketing trackers.
        </p>
        <p>
          We measure how the Service is used with Google Analytics 4 (the Google tag, gtag.js). It
          reports which pages are opened, which audio formats and bitrates are requested, whether a
          download finished, failed or was cancelled, and the text typed into the search box
          truncated to 60 characters. That tag stores a browser identifier and cookies on your
          device, and Google processes the data on our behalf, potentially in the United States. We
          do not send names, email addresses, SoundCloud links, track or artist titles, tokens or
          API keys, and we do not build individual profiles or connect this data to you.
        </p>
        <p>
          Pages are served over HTTPS with security headers in place, and the download endpoint is
          limited to fetching public audio streams for a track id.
        </p>
      </LegalSection>

      <LegalSection heading="4. Your rights and children">
        <p>
          You can ask us what personal data we hold about you, request correction, or ask for
          deletion by writing to {SITE.supportEmail}. We will answer within 30 days. The Service is
          not directed at children under 13 and we do not knowingly collect their data.
        </p>
      </LegalSection>

      <LegalSection heading="5. Changes to this policy and contact">
        <p>
          If this policy changes, the "last updated" date above is revised and the new version
          applies from that point. Privacy questions: {SITE.supportEmail}.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
