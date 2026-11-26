import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";

import appCss from "~/styles/app.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      // The title is what a client sees in the browser tab, and in the preview
      // card when the link is texted or emailed — it was still the scaffold's
      // "My site".
      { title: "Trust Care Agency — Home Care in Chicago & the Suburbs" },
      {
        name: "description",
        content:
          "Trust Care Agency provides compassionate home care for families across Chicago, Chicagoland, and the surrounding suburbs — companion care, personal care, dementia and Alzheimer's support, respite care, and post-hospital recovery. Call (815) 260-3106.",
      },
      // Open Graph tags drive the preview card when the link is pasted into a
      // text, email or messaging app — the first thing a prospective client sees.
      { property: "og:title", content: "Trust Care Agency — Home Care in Chicago & the Suburbs" },
      {
        property: "og:description",
        content:
          "Compassionate home care across Chicago, Chicagoland and the surrounding suburbs. Call (815) 260-3106.",
      },
      { property: "og:type", content: "website" },
      { property: "og:image", content: "/trustcare-logo.png" },
      { name: "theme-color", content: "#404040" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/trustcare-logo.png" },
    ],
  }),
  notFoundComponent: () => <div>Page not found</div>,
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
