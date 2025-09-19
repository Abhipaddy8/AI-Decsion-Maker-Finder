import { EnrichmentField, EnrichmentResult } from '../core/types';

interface GeneralAgentContext {
  companyName?: string;
  discoveredData?: Record<string, unknown>;
  emailContext?: {
    companyDomain?: string;
    companyNameGuess?: string;
  };
}

interface GeneralAgentTools {
  search: (query: string, options?: { limit?: number; scrapeOptions?: { formats?: string[] } }) => Promise<SearchResult[]>;
  scrape: (url: string) => Promise<ScrapeResult>;
  extractStructuredData: (content: string, fields: EnrichmentField[], context: unknown) => Promise<Record<string, EnrichmentResult>>;
}

interface SearchResult {
  url: string;
  title?: string;
  markdown?: string;
  content?: string;
}

interface ScrapeResult {
  success: boolean;
  markdown?: string;
  html?: string;
}

export class GeneralAgent {
  name = 'general-agent';
  description = 'Handles miscellaneous fields that don\'t fit into specific categories like executives, custom data points, etc.';
  private tools: GeneralAgentTools;

  constructor(tools: GeneralAgentTools) {
    this.tools = tools;
  }

  async execute(
    context: GeneralAgentContext,
    fields: EnrichmentField[]
  ): Promise<Record<string, EnrichmentResult>> {
    console.log('[AGENT-GENERAL] Starting LinkedIn-First Decision Maker Discovery');

    const companyName = context.companyName ||
                       context.discoveredData?.companyName ||
                       context.emailContext?.companyNameGuess;

    const companyDomain = context.emailContext?.companyDomain;

    console.log(`[AGENT-GENERAL] Company name: ${companyName || 'Not found'}`);
    console.log(`[AGENT-GENERAL] Company domain: ${companyDomain || 'Not found'}`);
    console.log(`[AGENT-GENERAL] Fields to enrich: ${fields.map(f => f.name).join(', ')}`);

    if (!companyName && !companyDomain) {
      console.log('[AGENT-GENERAL] No company name or domain available, skipping general phase');
      return {};
    }

    const results: Record<string, EnrichmentResult> = {};

    try {
      // NEW PHASED WORKFLOW: First find company LinkedIn, then extract decision makers
      let companyLinkedInUrl: string | null = null;

      // Phase 1: Find the company's official LinkedIn page
      if (companyName) {
        console.log(`[AGENT-GENERAL] Phase 1: Finding company LinkedIn page for ${companyName}`);
        companyLinkedInUrl = await this.findCompanyLinkedInPage(companyName, companyDomain);

        if (companyLinkedInUrl) {
          console.log(`[AGENT-GENERAL] Found company LinkedIn: ${companyLinkedInUrl}`);
        } else {
          console.log(`[AGENT-GENERAL] Company LinkedIn not found, falling back to general search`);
        }
      }

      // Phase 2: Build search queries based on LinkedIn discovery
      const searchQueries = this.buildLinkedInFirstQueries(fields, companyName as string | undefined, companyDomain, companyLinkedInUrl);
      
      console.log(`[AGENT-GENERAL] Built ${searchQueries.length} search queries`);
      
      let allSearchResults: SearchResult[] = [];
      
      for (const query of searchQueries) {
        try {
          console.log(`[AGENT-GENERAL] Searching: ${query}`);
          const searchResults = await this.tools.search(query, { 
            limit: 3,
            scrapeOptions: { formats: ['markdown'] }
          });
          
          if (searchResults && searchResults.length > 0) {
            console.log(`[AGENT-GENERAL] Found ${searchResults.length} results`);
            allSearchResults = allSearchResults.concat(searchResults);
          }
        } catch (error) {
          console.log(`[AGENT-GENERAL] Search failed for query "${query}": ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      
      // Also try to scrape the company website for executive info
      if (companyDomain && this.hasExecutiveFields(fields)) {
        try {
          console.log(`[AGENT-GENERAL] Scraping company website for executive info`);
          const aboutUrl = `https://${companyDomain}/about`;
          const teamUrl = `https://${companyDomain}/team`;
          const leadershipUrl = `https://${companyDomain}/leadership`;
          
          for (const url of [aboutUrl, teamUrl, leadershipUrl]) {
            try {
              const scraped = await this.tools.scrape(url);
              if (scraped.success && scraped.markdown) {
                allSearchResults.push({
                  url,
                  title: 'Company Leadership Page',
                  markdown: scraped.markdown,
                  content: scraped.markdown
                });
                console.log(`[AGENT-GENERAL] Successfully scraped ${url}`);
                break; // Stop after first successful scrape
              }
            } catch (error) {
              // Continue to next URL
              console.log(`[AGENT-GENERAL] Failed to scrape ${url}: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        } catch (error) {
          console.log(`[AGENT-GENERAL] Failed to scrape company website: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      
      // Rank results: LinkedIn first, then company website, then general web
      const rankedResults = allSearchResults.sort((a, b) => {
        const aIsLinkedIn = a.url.includes('linkedin.com/in') || a.url.includes('linkedin.com/company');
        const bIsLinkedIn = b.url.includes('linkedin.com/in') || b.url.includes('linkedin.com/company');

        if (aIsLinkedIn && !bIsLinkedIn) return -1;
        if (!aIsLinkedIn && bIsLinkedIn) return 1;

        // Within non-LinkedIn results, prefer company website
        const aIsCompanySite = companyDomain && a.url.includes(companyDomain);
        const bIsCompanySite = companyDomain && b.url.includes(companyDomain);

        if (aIsCompanySite && !bIsCompanySite) return -1;
        if (!aIsCompanySite && bIsCompanySite) return 1;

        return 0;
      });

      // Deduplicate by URL
      const uniqueResults = Array.from(
        new Map(rankedResults.map(r => [r.url, r])).values()
      );

      console.log(`[AGENT-GENERAL] Total unique results: ${uniqueResults.length}`);
      console.log(`[AGENT-GENERAL] LinkedIn results: ${uniqueResults.filter(r => r.url.includes('linkedin.com')).length}`);

      if (uniqueResults.length === 0) {
        console.log('[AGENT-GENERAL] No search results found');
        return {};
      }

      // Combine content for extraction, prioritizing LinkedIn
      const linkedInResults = uniqueResults.filter(r => r.url.includes('linkedin.com'));
      const otherResults = uniqueResults.filter(r => !r.url.includes('linkedin.com'));

      const prioritizedResults = [...linkedInResults, ...otherResults].slice(0, 10);

      const combinedContent = prioritizedResults
        .map(r => `URL: ${r.url}\nTitle: ${r.title || 'No title'}\nContent:\n${r.markdown || r.content || ''}`)
        .filter(Boolean)
        .join('\n\n---\n\n');
      
      // Extract structured data with company LinkedIn foundation
      const enrichmentContext = {
        companyName,
        companyDomain,
        targetDomain: companyDomain,
        companyLinkedInUrl,
        instruction: `Extract the requested information about ${companyName || companyDomain}.

        LINKEDIN-FIRST WORKFLOW: Company LinkedIn Page as Foundation

        Phase 1: Company LinkedIn Page Analysis
        - If company LinkedIn page URL is provided (${companyLinkedInUrl || 'Not found'}), use it as the authoritative source
        - Company LinkedIn pages show current employees and their exact titles
        - This is the most reliable source for current decision makers

        Phase 2: Individual LinkedIn Profile Validation
        - Look for LinkedIn profiles (linkedin.com/in) that show "Current" employment at ${companyName}
        - Extract current job titles, full names, and profile URLs
        - Only include profiles that clearly show current employment

        Phase 3: Cross-Referencing Strategy
        - Cross-reference LinkedIn data with company website information
        - If sources conflict, LinkedIn profiles with "Current" status take priority
        - Verify that titles match exactly with requested roles

        Executive Information Extraction Rules:
        1. **CURRENT EMPLOYEES ONLY**: Only include people with "Current" status on LinkedIn
        2. **EXACT TITLE MATCH**: CEO must be "CEO" or "Chief Executive Officer", etc.
        3. **INCLUDE PROFILE URLS**: Always include LinkedIn profile URLs when found
        4. **PRIORITIZE COMPANY-LINKEDIN**: People listed on company LinkedIn page are most reliable

        For custom decision maker roles:
        - Search LinkedIn profiles with exact role titles at ${companyName}
        - Verify current employment status
        - Include role description and profile URL

        Quality Assurance:
        - If no current decision makers found, return "No current decision makers found"
        - Do not guess or infer information
        - Only include explicitly stated information with clear sources`,
        ...(context as Record<string, unknown>)
      };
      
      const enrichmentResults = await this.tools.extractStructuredData(
        combinedContent,
        fields,
        enrichmentContext
      );
      
      // Process results
      for (const [fieldName, enrichment] of Object.entries(enrichmentResults)) {
        if (enrichment && enrichment.value) {
          results[fieldName] = enrichment;
        }
      }
      
      console.log(`[AGENT-GENERAL] Extracted ${Object.keys(results).length} fields`);
      
    } catch (error) {
      console.error('[AGENT-GENERAL] Error during general information extraction:', error);
    }
    
    return results;
  }
  
  private buildSearchQueries(fields: EnrichmentField[], companyName?: string, companyDomain?: string): string[] {
    const queries: string[] = [];
    
    // Group fields by type
    const executiveFields = fields.filter(f => this.isExecutiveField(f));
    const otherFields = fields.filter(f => !this.isExecutiveField(f));
    
    // Build queries for executive fields - PRIORITIZE LINKEDIN
    if (executiveFields.length > 0) {
      const titles = executiveFields.map(f => this.extractTitle(f)).filter(Boolean);

      // LinkedIn-specific queries (highest priority)
      if (companyName) {
        // Company LinkedIn page for current employees
        queries.push(`site:linkedin.com/company "${companyName}" ${titles.join(' OR ')}`);
        queries.push(`site:linkedin.com/in "${companyName}" ${titles.join(' OR ')}`);
        // Search for individual LinkedIn profiles
        titles.forEach(title => {
          queries.push(`site:linkedin.com/in "${title}" "${companyName}"`);
        });
        // General executive search on LinkedIn
        queries.push(`site:linkedin.com/in "${companyName}" leadership team executives`);
      }

      // Website queries (secondary priority)
      if (companyDomain) {
        queries.push(`site:${companyDomain} team leadership about executives`);
        queries.push(`site:${companyDomain} about-us team`);
        queries.push(`site:${companyDomain} leadership`);
      }

      // General web search (last resort)
      if (companyName) {
        queries.push(`"${companyName}" ${titles.join(' ')} current 2025`);
      }
    }
    
    // Build queries for other fields
    for (const field of otherFields) {
      const fieldTerms = this.getSearchTermsForField(field);
      
      if (companyName) {
        queries.push(`"${companyName}" ${fieldTerms}`);
      }
      
      if (companyDomain) {
        queries.push(`site:${companyDomain} ${fieldTerms}`);
      }
    }
    
    // Add news search for recent information
    if (companyName && fields.length > 0) {
      queries.push(`"${companyName}" news announcement ${new Date().getFullYear()}`);
    }
    
    return queries;
  }
  
  private hasExecutiveFields(fields: EnrichmentField[]): boolean {
    return fields.some(f => this.isExecutiveField(f));
  }
  
  private isExecutiveField(field: EnrichmentField): boolean {
    const name = field.name.toLowerCase();
    const desc = field.description.toLowerCase();
    
    const executiveTitles = ['ceo', 'cto', 'cfo', 'coo', 'cmo', 'cpo', 'chief', 'founder', 'president', 'director'];
    
    return executiveTitles.some(title => name.includes(title) || desc.includes(title));
  }
  
  private extractTitle(field: EnrichmentField): string {
    const name = field.name.toLowerCase();
    const desc = field.description.toLowerCase();
    
    // Map common variations to standard titles
    if (name.includes('ceo') || desc.includes('chief executive')) return 'CEO';
    if (name.includes('cto') || desc.includes('chief technology')) return 'CTO';
    if (name.includes('cfo') || desc.includes('chief financial')) return 'CFO';
    if (name.includes('coo') || desc.includes('chief operating')) return 'COO';
    if (name.includes('cmo') || desc.includes('chief marketing')) return 'CMO';
    if (name.includes('cpo') || desc.includes('chief product')) return 'CPO';
    if (name.includes('founder')) return 'founder';
    if (name.includes('president')) return 'president';
    
    return field.name;
  }
  
  private getSearchTermsForField(field: EnrichmentField): string {
    // Generate search terms based on field name and description
    const terms = [field.name];

    // Add related terms from description
    if (field.description) {
      // Extract key phrases from description
      const keyPhrases = field.description
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter(word => word.length > 3 && !['this', 'that', 'what', 'when', 'where', 'which'].includes(word));

      terms.push(...keyPhrases.slice(0, 3)); // Add top 3 key words
    }

    return terms.join(' ');
  }

  // NEW METHOD: Find company's official LinkedIn page
  private async findCompanyLinkedInPage(companyName: string, companyDomain?: string): Promise<string | null> {
    try {
      console.log(`[AGENT-GENERAL] Searching for ${companyName} LinkedIn page`);

      // Search for company LinkedIn page
      const linkedinSearchQuery = `site:linkedin.com/company "${companyName}"`;
      console.log(`[AGENT-GENERAL] LinkedIn search query: ${linkedinSearchQuery}`);

      const searchResults = await this.tools.search(linkedinSearchQuery, {
        limit: 5,
        scrapeOptions: { formats: ['markdown'] }
      });

      if (!searchResults || searchResults.length === 0) {
        console.log(`[AGENT-GENERAL] No LinkedIn company page found for ${companyName}`);
        return null;
      }

      // Find the most relevant LinkedIn company page
      const companyPages = searchResults.filter(result =>
        result.url.includes('linkedin.com/company') &&
        result.url.toLowerCase().includes(companyName.toLowerCase().replace(/\s+/g, '-'))
      );

      if (companyPages.length > 0) {
        // Use the first (most relevant) company page
        const companyPage = companyPages[0];
        console.log(`[AGENT-GENERAL] Found company LinkedIn: ${companyPage.url}`);
        return companyPage.url;
      }

      // Fallback: any linkedin.com/company result
      const anyCompanyPage = searchResults.find(result => result.url.includes('linkedin.com/company'));
      if (anyCompanyPage) {
        console.log(`[AGENT-GENERAL] Using fallback company LinkedIn: ${anyCompanyPage.url}`);
        return anyCompanyPage.url;
      }

      console.log(`[AGENT-GENERAL] No suitable company LinkedIn page found`);
      return null;

    } catch (error) {
      console.log(`[AGENT-GENERAL] Error finding company LinkedIn page: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  // NEW METHOD: Build LinkedIn-first search queries
  private buildLinkedInFirstQueries(
    fields: EnrichmentField[],
    companyName?: string,
    companyDomain?: string,
    companyLinkedInUrl?: string | null
  ): string[] {
    const queries: string[] = [];
    const executiveFields = fields.filter(f => this.isExecutiveField(f));
    const otherFields = fields.filter(f => !this.isExecutiveField(f));

    if (executiveFields.length > 0) {
      const titles = executiveFields.map(f => this.extractTitle(f)).filter(Boolean);

      // STRATEGY 1: Search within company LinkedIn page (most reliable)
      if (companyLinkedInUrl) {
        // Extract company name from LinkedIn URL for better search
        const linkedinCompanyName = this.extractLinkedInCompanyName(companyLinkedInUrl);
        queries.push(`site:linkedin.com/in "${linkedinCompanyName}" ${titles.join(' OR ')}`);
        queries.push(`site:linkedin.com/in "${companyName}" ${titles.join(' OR ')}`);
      }

      // STRATEGY 2: Company-specific LinkedIn searches
      if (companyName) {
        titles.forEach(title => {
          queries.push(`site:linkedin.com/in "${title}" "${companyName}" current`);
        });
        queries.push(`site:linkedin.com/in "${companyName}" leadership team`);
        queries.push(`site:linkedin.com/in "${companyName}" executives`);
      }

      // STRATEGY 3: Company website as backup
      if (companyDomain) {
        queries.push(`site:${companyDomain} team leadership about executives`);
        queries.push(`site:${companyDomain} about-us`);
      }

      // STRATEGY 4: General web search (last resort)
      if (companyName) {
        queries.push(`"${companyName}" ${titles.join(' ')} 2025`);
      }
    }

    // Handle non-executive fields
    for (const field of otherFields) {
      const fieldTerms = this.getSearchTermsForField(field);

      if (companyName) {
        queries.push(`"${companyName}" ${fieldTerms}`);
      }

      if (companyDomain) {
        queries.push(`site:${companyDomain} ${fieldTerms}`);
      }
    }

    return queries;
  }

  // HELPER: Extract company name from LinkedIn URL
  private extractLinkedInCompanyName(linkedinUrl: string): string {
    try {
      const url = new URL(linkedinUrl);
      const pathParts = url.pathname.split('/').filter(part => part.length > 0);

      // For linkedin.com/company/company-name
      if (pathParts[0] === 'company' && pathParts[1]) {
        return pathParts[1].replace(/-/g, ' ');
      }

      return '';
    } catch {
      return '';
    }
  }
}