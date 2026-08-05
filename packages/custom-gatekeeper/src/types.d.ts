export interface OrganizationProfile {
  organizationId: "departure";
  executiveId: "art-bradshaw";
  canonicalMarkdown: string;
  updatedAt: string;
}

/** Canonical company knowledge for every Ontix IQ conversation and future workflow. */
export interface CustomSession {
  /** Read the full canonical DEPARTURE organization profile. */
  getOrganizationProfile(): Promise<OrganizationProfile>;
  /** Find lines containing all or any supplied terms. */
  searchOrganizationContext(terms: string[], matchAll?: boolean): Promise<string[]>;
}
