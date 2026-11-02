import { createFileRoute } from "@tanstack/react-router";

import { LegalPage, LegalSection } from "@/components/Page";
import { SITE } from "@/lib/site";
import { seoHead } from "@/lib/seo";

export const Route = createFileRoute("/dmca")({
  head: () =>
    seoHead({
      title: `DMCA & Copyright Policy — ${SITE.name}`,
      description: `How copyright holders send a takedown notice to ${SITE.name}, what a valid notice must contain, and where to send it.`,
      path: "/dmca",
      ogType: "article",
    }),
  component: Dmca,
});

function Dmca() {
  return (
    <LegalPage
      title="DMCA & Copyright Policy"
      updated="31 October 2026"
      intro={`${SITE.name} hosts no media files. It acts solely as a real-time proxy that relays audio SoundCloud already serves publicly, so there is no library of recordings on our servers to remove.`}
    >
      <LegalSection heading="1. Takedown process">
        <p>
          Because we store nothing, a copyright notice is handled by blocking the requested
          SoundCloud URL from being resolved through the Service. Once a URL is on the block list,
          pasting it returns a refusal instead of a download.
        </p>
        <p>
          Notices that are complete and in good standing are actioned within 2 business days. We
          also notify the account holder where contact details are available.
        </p>
      </LegalSection>

      <LegalSection heading="2. Filing a notice">
        <p>Send an email to our designated agent containing all of the following:</p>
        <ul className="list-disc space-y-2 pl-5">
          <li>Identification of the copyrighted work you claim is infringed (title, artist, album, and where it is officially published).</li>
          <li>The exact SoundCloud URL in question — the track, playlist or profile link.</li>
          <li>Your contact information: name, postal address, email address and telephone number.</li>
          <li>A statement that you have a good-faith belief that the disputed use is not authorised by the copyright owner, its agent, or the law.</li>
          <li>A statement, under penalty of perjury, that the information in your notice is accurate and that you are the copyright owner or authorised to act on the owner's behalf.</li>
          <li>Your physical or electronic signature.</li>
        </ul>
        <p>
          Incomplete notices slow the process down; we may reply to ask for the missing piece
          before acting.
        </p>
      </LegalSection>

      <LegalSection heading="3. Designated agent contact">
        <p>
          Send notices to <span className="text-foreground">{SITE.dmcaEmail}</span> with the subject
          line "DMCA Notice". For counter-notices, include the same information plus a statement
          consenting to the jurisdiction of the federal district court where you reside.
        </p>
      </LegalSection>

      <LegalSection heading="4. Repeat infringers and abuse">
        <p>
          Notices filed to silence criticism, parody or licensing disputes are not copyright
          claims; they are abuse of this process and will be rejected. Filing a knowingly false
          notice can expose you to damages.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
