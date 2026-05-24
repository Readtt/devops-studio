import { useId } from "react";
import { cn } from "@/lib/utils";

/**
 * Azure DevOps brand mark — inlined from thesvg.org's official
 * `azure-devops-starter/default.svg` (Microsoft brand asset, provided
 * for identification under nominative-fair-use per thesvg.org's
 * terms). Gradient ids are React-useId-scoped so two copies on screen
 * don't collide on `#a` / `#b` defs.
 *
 * Pass `mono` when the icon sits inside a high-density text run and
 * should inherit currentColor for legibility (e.g. inside a button
 * label) rather than render the brand gradient.
 */
export function AzureDevOpsLogo({
  size = 14,
  className,
  mono = false,
  title = "Azure DevOps",
}: {
  size?: number;
  className?: string;
  mono?: boolean;
  title?: string;
}) {
  const id = useId();
  const grad1 = `ado-g1-${id}`;
  const grad2 = `ado-g2-${id}`;
  if (mono) {
    // Simplified single-shape silhouette for inline text contexts —
    // the gradient version doesn't read at button-label scale and
    // currentColor + the loop outline is enough at 12–14 px.
    return (
      <svg
        role="img"
        aria-label={title}
        viewBox="0 0 18 18"
        width={size}
        height={size}
        fill="currentColor"
        className={cn("shrink-0", className)}
      >
        <path d="M11.31 6.412a5.454 5.454 0 1 1-5.453 5.453 5.454 5.454 0 0 1 5.453-5.453zm0 1.176a4.278 4.278 0 1 0 4.278 4.277 4.278 4.278 0 0 0-4.278-4.277z" />
        <path d="M13.33 10.9a1.13 1.13 0 0 0-1.12 1.13 2.39 2.39 0 1 1-2.68-2.38v.57a1.83 1.83 0 1 0 2.11 1.81 1.69 1.69 0 0 1 3.37-.14H14.4a1.13 1.13 0 0 0-1.07-.99z" />
      </svg>
    );
  }
  return (
    <svg
      role="img"
      aria-label={title}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 18 18"
      width={size}
      height={size}
      className={cn("shrink-0", className)}
    >
      <defs>
        <linearGradient
          id={grad1}
          x1="306.077"
          y1="-363.569"
          x2="305.834"
          y2="-351.67"
          gradientTransform="matrix(1, 0, 0, -1, -297, -351)"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#2889e0" />
          <stop offset="1" stopColor="#50e6ff" />
        </linearGradient>
        <linearGradient
          id={grad2}
          x1="310.996"
          y1="-367.576"
          x2="305.457"
          y2="-357.862"
          gradientTransform="matrix(1, 0, 0, -1, -297, -351)"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#704cb3" />
          <stop offset="1" stopColor="#c398e9" />
        </linearGradient>
      </defs>
      <path
        fill={`url(#${grad1})`}
        d="M17.85,9.71c-.545,1.979-1.868,2.634-3.293,3.239a1.825,1.825,0,0,1-.694.119H7.714c-1.159,0-2.923-.019-3.747-.028a1.946,1.946,0,0,1-.875-.2A5,5,0,0,1,.153,8.83C.071,8.1-.106,5.123,4.239,3.977A5.33,5.33,0,0,1,9.307.68a5.045,5.045,0,0,1,5.068,4.73C15.823,5.7,18.14,7.13,17.85,9.71Z"
      />
      <path
        fill="#fff"
        d="M16.764,11.866A5.454,5.454,0,1,1,11.31,6.412,5.454,5.454,0,0,1,16.764,11.866Z"
      />
      <path
        fillRule="evenodd"
        fill={`url(#${grad2})`}
        d="M11.31,16.6a4.736,4.736,0,1,0-4.736-4.736A4.736,4.736,0,0,0,11.31,16.6Zm0,.717a5.454,5.454,0,1,0-5.453-5.453,5.453,5.453,0,0,0,5.453,5.453Z"
      />
      <path
        fill="#417be9"
        d="M13.332,10.9a1.127,1.127,0,0,0-1.124,1.129,2.39,2.39,0,1,1-4.082-1.693,2.371,2.371,0,0,1,1.405-.689v.57a1.835,1.835,0,1,0,2.114,1.812,1.687,1.687,0,0,1,3.368-.141h-.565a1.127,1.127,0,0,0-1.116-.988Z"
      />
      <path
        fill="#1453c8"
        d="M13.317,13.77a1.667,1.667,0,0,1-.777-.192l.287-.516a1.111,1.111,0,0,0,.49.114,1.153,1.153,0,0,0,1.11-.89h.586A1.739,1.739,0,0,1,13.317,13.77Z"
      />
    </svg>
  );
}
