import { createFileRoute } from "@tanstack/react-router";

import { LegalPage, LegalSection } from "@/components/Page";
import { SITE } from "@/lib/site";
import { seoHead } from "@/lib/seo";

export const Route = createFileRoute("/terms")({
  head: () =>
    seoHead({
      title: `Terms of Service — ${SITE.name}`,
      description: `The rules for using ${SITE.name}: permitted use, intellectual property, non-affiliation with SoundCloud, and service limitations.`,
      path: "/terms",
      ogType: "article",
    }),
  component: Terms,
});

function Terms() {
  return (
    <LegalPage
      title="Terms of Service"
      updated="31 October 2026"
      intro={`By opening or using ${SITE.name} at ${SITE.domain} (the "Service"), you accept these terms. If you do not agree with any part of them, stop using the Service.`}
    >
      <LegalSection heading="1. Acceptance of terms and intended use">
        <p>
          The Service is a tool that fetches audio that SoundCloud already serves publicly and
          hands it to your browser. It is offered for personal, non-commercial use on content you
          own or have a clear legal right to save — for example your own uploads, material under a
          permissive licence, or content covered by fair use in your jurisdiction.
        </p>
      </LegalSection>

      <LegalSection heading="2. Intellectual property rights">
        <p>
          You are solely responsible for what you download and how you use it. Do not download,
          re-publish, sell, sample or redistribute work you do not own or have permission to use.
          Rights in every track, artwork and profile stay with their owners; nothing in these terms
          transfers any rights to you or to us.
        </p>
        <p>
          Re-uploading or monetising other people's recordings is not a permitted use of the
          Service, and repeated abuse may lead to your access being blocked.
        </p>
      </LegalSection>

      <LegalSection heading="3. SoundCloud non-affiliation">
        <p>
          {SITE.name} is an independent, automated tool. It has no official partnership,
          sponsorship, endorsement or connection with SoundCloud Limited. SoundCloud and related
          marks belong to SoundCloud Limited; other marks belong to their respective owners.
        </p>
        <p>
          Access to SoundCloud's public endpoints is controlled by SoundCloud, so availability of
          any track, quality level or feature can change or disappear without notice to us.
        </p>
      </LegalSection>

      <LegalSection heading="4. Service availability and limitations">
        <p>
          The Service is provided "as is" and "as available", without warranties of any kind,
          express or implied, including fitness for a particular purpose and non-infringement.
        </p>
        <p>
          Downloads can fail because a track is private, region-locked, Go+ only, DRM-protected,
          removed by its owner, or rate-limited upstream. We do not guarantee uninterrupted access,
          a particular bitrate, or that a file will play on every device. To the fullest extent
          allowed by law, we are not liable for indirect or consequential loss arising from use of
          the Service.
        </p>
      </LegalSection>

      <LegalSection heading="5. Prohibited activities">
        <p>You agree not to:</p>
        <ul className="list-disc space-y-2 pl-5">
          <li>scrape, crawl or mass-harvest the Service or its endpoints with automated scripts;</li>
          <li>flood download or resolve endpoints with repeated requests, or attempt denial of service;</li>
          <li>probe, bypass or reverse-engineer access controls, or use the Service to reach private, paywalled or DRM-protected content;</li>
          <li>use the Service to infringe copyright, distribute malware, or mislead others about the origin of a file;</li>
          <li>resell, white-label or operate the Service as your own downloading business.</li>
        </ul>
      </LegalSection>

      <LegalSection heading="6. Changes and contact">
        <p>
          We may update these terms; the "last updated" date above shows the current version.
          Questions about these terms: {SITE.supportEmail}. Copyright notices: {SITE.dmcaEmail}.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
