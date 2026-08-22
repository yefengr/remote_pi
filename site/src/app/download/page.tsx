import type { Metadata } from "next";
import { Callout } from "@/components/callout";
import { RevealController } from "@/components/landing/reveal-controller";
import { IconAndroid, IconDownload } from "@/components/landing/icons";
import { ShaCopy } from "@/components/download/sha-copy";
import { loadAppManifest, type AppArtifact } from "@/lib/app-release";

export const metadata: Metadata = {
  title: "Download",
  description:
    "Download the Remote Pi Android app as a signed APK.",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)) - 1, units.length - 1);
  return `${(bytes / 1024 ** (index + 1)).toFixed(1)} ${units[index]}`;
}

function artifactFileName(artifact: AppArtifact): string {
  try {
    return new URL(artifact.url).pathname.split("/").at(-1) || "RemotePi.apk";
  } catch {
    return "RemotePi.apk";
  }
}

function DownloadCard({ artifact, live }: { artifact: AppArtifact; live: boolean }) {
  return (
    <div className="dl-card">
      <div className="dl-card-top">
        <span className="dl-fmt">.{artifact.format}</span>
        <span className="dl-size">{formatBytes(artifact.size)}</span>
      </div>
      <div className="dl-arch">Universal APK</div>
      <div className="dl-file">{artifactFileName(artifact)}</div>
      {live ? (
        <a className="btn btn-primary dl-btn" href={artifact.url} download>
          <IconDownload /> Download RemotePi.apk
        </a>
      ) : (
        <span
          className="btn dl-btn dl-btn-off"
          aria-disabled="true"
          title="Not published yet"
        >
          <IconDownload /> Unavailable
        </span>
      )}
      <ShaCopy sha256={artifact.sha256} />
    </div>
  );
}

function ReleaseNotes({
  version,
  notes,
  live,
}: {
  version: string;
  notes: string;
  live: boolean;
}) {
  return (
    <>
      {!live ? (
        <div className="reveal" style={{ marginTop: 24, maxWidth: 760 }}>
          <Callout variant="warning" title="Not published yet">
            <p>
              This build hasn&apos;t been published to the download host yet, so
              the link below isn&apos;t live. The version, size, and checksum are
              a preview of the layout - check back soon.
            </p>
          </Callout>
        </div>
      ) : null}
      {notes ? (
        <div className="reveal" style={{ marginTop: 20, maxWidth: 760 }}>
          <Callout title={`What's new in ${version}`}>
            <p>{notes}</p>
          </Callout>
        </div>
      ) : null}
    </>
  );
}

export default async function DownloadPage() {
  const app = await loadAppManifest();
  const apk = app.manifest.artifacts[0];

  return (
    <div className="page">
      <div className="page-body">
        <div className="wrap">
          <header className="page-head reveal" style={{ maxWidth: 760 }}>
            <span className="eyebrow">Download</span>
            <h1>Download Remote Pi</h1>
            <p className="lede">
              Get the Remote Pi Android app directly from CI. Pair once with a
              QR code, then drive your agents from anywhere.
            </p>
          </header>

          <section className="dl-product reveal" id="android">
            <div className="section-head">
              <span className="eyebrow">Mobile · Android</span>
              <h2>Remote Pi - App (Android)</h2>
              <p>
                Pair your phone with a QR code, then drive your agents from
                anywhere. Install the signed APK directly, with no Play Store
                required.
              </p>
            </div>
            <div className="dl-meta">
              <span>Version {app.manifest.version}</span>
              <span>Released {app.manifest.date}</span>
              <span>Direct APK · signed release</span>
            </div>

            <ReleaseNotes
              version={app.manifest.version}
              notes={app.manifest.notes}
              live={app.live}
            />

            {apk ? (
              <div className="dl-os" id="android-build">
                <div className="dl-os-head">
                  <span className="dl-os-icon">
                    <IconAndroid />
                  </span>
                  <div className="dl-os-titles">
                    <h3>Android</h3>
                    <p>One universal APK for phones and tablets.</p>
                  </div>
                </div>
                <div className="dl-cards dl-cards-solo">
                  <DownloadCard artifact={apk} live={app.live} />
                </div>
                <div className="dl-os-help">
                  <div className="dl-note">
                    <ol>
                      <li>
                        Download <code>RemotePi.apk</code> to your phone.
                      </li>
                      <li>Tap the file to start installing.</li>
                      <li>
                        If Android blocks it, allow your browser to{" "}
                        <strong>install unknown apps</strong> when prompted,
                        then continue.
                      </li>
                      <li>
                        Optional: check the <strong>SHA-256</strong> above
                        matches the file before installing.
                      </li>
                    </ol>
                    <p className="dl-note-foot">
                      Prefer a store? Remote Pi is also on{" "}
                      <a
                        href="https://play.google.com/store/apps/details?id=work.jacobmoura.remotepi"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Google Play
                      </a>
                      .
                    </p>
                  </div>
                </div>
              </div>
            ) : null}
          </section>
        </div>
      </div>
      <RevealController />
    </div>
  );
}
