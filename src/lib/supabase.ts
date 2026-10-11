import { createClient, SupabaseClient, User, Session } from '@supabase/supabase-js';
import {
  UserProfile,
  Application,
  QuizAttempt,
  Company,
  Notice,
} from '../types';

// Environment variables & dynamic client configuration
const LOCAL_STORAGE_URL_KEY = 'ppp_supabase_url';
const LOCAL_STORAGE_ANON_KEY = 'ppp_supabase_anon_key';

export interface SupabaseConfigInfo {
  url: string;
  anonKey: string;
  source: 'env' | 'custom' | 'none';
  isValid: boolean;
}

export function getStoredSupabaseConfig(): SupabaseConfigInfo {
  let customUrl = '';
  let customKey = '';
  try {
    customUrl = (localStorage.getItem(LOCAL_STORAGE_URL_KEY) || '').trim();
    customKey = (localStorage.getItem(LOCAL_STORAGE_ANON_KEY) || '').trim();
  } catch {}

  if (customUrl && customKey && customUrl.startsWith('https://')) {
    return {
      url: customUrl,
      anonKey: customKey,
      source: 'custom',
      isValid: true,
    };
  }

  const envUrl = (import.meta.env.VITE_SUPABASE_URL || '').trim();
  const envKey = (import.meta.env.VITE_SUPABASE_ANON_KEY || '').trim();

  if (envUrl && envKey && envUrl.startsWith('https://') && !envUrl.includes('placeholder')) {
    return {
      url: envUrl,
      anonKey: envKey,
      source: 'env',
      isValid: true,
    };
  }

  return {
    url: customUrl || envUrl || '',
    anonKey: customKey || envKey || '',
    source: 'none',
    isValid: false,
  };
}

let activeConfig = getStoredSupabaseConfig();

export let isSupabaseConfigured = activeConfig.isValid;

export const getActiveSupabaseUrl = () => activeConfig.url;
export const getActiveAnonKey = () => activeConfig.anonKey;

// Masked display for UI status badge (never reveals full anon key)
export const getMaskedSupabaseUrl = () => {
  if (!activeConfig.url) return 'Not configured';
  try {
    const parsed = new URL(activeConfig.url);
    return `${parsed.protocol}//${parsed.hostname}`;
  } catch {
    return activeConfig.url.substring(0, 15) + '...';
  }
};

export const getMaskedAnonKey = () => {
  if (!activeConfig.anonKey) return 'Not configured';
  if (activeConfig.anonKey.length < 12) return '••••••••';
  return `${activeConfig.anonKey.substring(0, 6)}••••••••${activeConfig.anonKey.substring(activeConfig.anonKey.length - 4)}`;
};

function createSupabaseInstance(url: string, anonKey: string): SupabaseClient | null {
  if (!url || !anonKey || !url.startsWith('https://') || url.includes('placeholder')) {
    return null;
  }
  try {
    return createClient(url, anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
  } catch (err) {
    console.error('[Supabase] Failed to initialize client:', err);
    return null;
  }
}

export let supabase: SupabaseClient | null = activeConfig.isValid
  ? createSupabaseInstance(activeConfig.url, activeConfig.anonKey)
  : null;

type ConfigChangeListener = (client: SupabaseClient | null, isConfigured: boolean) => void;
const configChangeListeners: Set<ConfigChangeListener> = new Set();

export function onSupabaseConfigChange(listener: ConfigChangeListener): () => void {
  configChangeListeners.add(listener);
  return () => {
    configChangeListeners.delete(listener);
  };
}

function notifyConfigListeners() {
  configChangeListeners.forEach((fn) => {
    try {
      fn(supabase, isSupabaseConfigured);
    } catch (e) {
      console.error('[Supabase] Listener error:', e);
    }
  });
}

export function setSupabaseConfig(url: string, anonKey: string): { success: boolean; error?: string } {
  const trimmedUrl = url.trim();
  const trimmedKey = anonKey.trim();

  if (!trimmedUrl.startsWith('https://')) {
    return { success: false, error: 'Project URL must start with https://' };
  }
  if (!trimmedKey || trimmedKey.length < 20) {
    return { success: false, error: 'Invalid anon key format (too short).' };
  }

  try {
    localStorage.setItem(LOCAL_STORAGE_URL_KEY, trimmedUrl);
    localStorage.setItem(LOCAL_STORAGE_ANON_KEY, trimmedKey);
  } catch (err: any) {
    return { success: false, error: 'Failed to save to local storage: ' + err.message };
  }

  activeConfig = {
    url: trimmedUrl,
    anonKey: trimmedKey,
    source: 'custom',
    isValid: true,
  };
  supabase = createSupabaseInstance(trimmedUrl, trimmedKey);
  isSupabaseConfigured = Boolean(supabase);

  notifyConfigListeners();
  return { success: true };
}

export function clearCustomSupabaseConfig() {
  try {
    localStorage.removeItem(LOCAL_STORAGE_URL_KEY);
    localStorage.removeItem(LOCAL_STORAGE_ANON_KEY);
  } catch {}

  activeConfig = getStoredSupabaseConfig();
  supabase = activeConfig.isValid
    ? createSupabaseInstance(activeConfig.url, activeConfig.anonKey)
    : null;
  isSupabaseConfigured = Boolean(supabase);

  notifyConfigListeners();
}

export interface TableStatusReport {
  isConfigured: boolean;
  url: string;
  maskedKey: string;
  hasActiveSession: boolean;
  userEmail: string | null;
  userId: string | null;
  tables: {
    profiles: boolean;
    applications: boolean;
    quiz_attempts: boolean;
    user_progress: boolean;
    companies: boolean;
    notices: boolean;
  };
  allTablesReady: boolean;
  missingTablesCount: number;
  lastChecked: string;
  error?: string;
}

/**
 * Checks connectivity and verifies if the expected database tables exist in Supabase.
 */
export async function checkSupabaseStatus(): Promise<TableStatusReport> {
  if (!supabase || !isSupabaseConfigured) {
    return {
      isConfigured: false,
      url: 'Not set',
      maskedKey: 'Not set',
      hasActiveSession: false,
      userEmail: null,
      userId: null,
      tables: {
        profiles: false,
        applications: false,
        quiz_attempts: false,
        user_progress: false,
        companies: false,
        notices: false,
      },
      allTablesReady: false,
      missingTablesCount: 6,
      lastChecked: new Date().toLocaleTimeString(),
      error: 'Environment variables VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are not configured.',
    };
  }

  // Get current user session
  let userEmail: string | null = null;
  let userId: string | null = null;
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.user) {
      userEmail = session.user.email || null;
      userId = session.user.id || null;
    }
  } catch {
    // Session check error ignored
  }

  const tableNames = [
    'profiles',
    'applications',
    'quiz_attempts',
    'user_progress',
    'companies',
    'notices',
  ] as const;

  const results: Record<string, boolean> = {
    profiles: false,
    applications: false,
    quiz_attempts: false,
    user_progress: false,
    companies: false,
    notices: false,
  };

  await Promise.all(
    tableNames.map(async (table) => {
      try {
        const { error } = await supabase!.from(table).select('*').limit(1);
        if (!error || error.code === 'PGRST116') {
          results[table] = true;
        } else if (error.message.includes('relation') || error.message.includes('schema cache')) {
          results[table] = false;
        } else {
          // If error is permission/RLS denied, the table DOES exist
          results[table] = true;
        }
      } catch {
        results[table] = false;
      }
    })
  );

  const missingCount = Object.values(results).filter((v) => !v).length;

  return {
    isConfigured: true,
    url: getMaskedSupabaseUrl(),
    maskedKey: getMaskedAnonKey(),
    hasActiveSession: Boolean(userId),
    userEmail,
    userId,
    tables: results as TableStatusReport['tables'],
    allTablesReady: missingCount === 0,
    missingTablesCount: missingCount,
    lastChecked: new Date().toLocaleTimeString(),
  };
}

// -----------------------------------------------------------------------------
// Database Operations (with graceful try/catch and fallback)
// -----------------------------------------------------------------------------

export async function fetchProfileFromSupabase(userId: string): Promise<UserProfile | null> {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single();

    if (error || !data) return null;

    return {
      id: data.id,
      name: data.name,
      email: data.email,
      rollNumber: data.roll_number || '',
      college: data.college || 'Apex Institute of Technology',
      branch: data.branch || 'Computer Science & Engineering',
      yearOfStudy: data.year_of_study || '3rd Year',
      cgpa: parseFloat(data.cgpa) || 8.0,
      graduationYear: data.graduation_year || 2027,
      role: data.role || 'student',
      targetCompanyTier: data.target_company_tier || 'Super Dream',
      phone: data.phone || '',
      activeBacklogs: data.active_backlogs || 0,
      streakDays: data.streak_days || 1,
      completedLessonsCount: data.completed_lessons_count || 0,
      totalStudyHours: parseFloat(data.total_study_hours) || 0,
    };
  } catch (err) {
    console.warn('[Supabase] fetchProfile error:', err);
    return null;
  }
}

export async function upsertProfileToSupabase(profile: UserProfile): Promise<{ success: boolean; error?: string }> {
  if (!supabase) return { success: false, error: 'Supabase client not connected' };
  try {
    const cleanYear = ['1st Year', '2nd Year', '3rd Year', '4th Year'].includes(profile.yearOfStudy)
      ? profile.yearOfStudy
      : '3rd Year';
    const cleanRole = profile.role === 'coordinator' ? 'coordinator' : 'student';
    const cleanTier = ['Super Dream', 'Dream', 'Core', 'Mass'].includes(profile.targetCompanyTier)
      ? profile.targetCompanyTier
      : 'Super Dream';
    const cleanCgpa = Math.min(10, Math.max(0, Number(profile.cgpa) || 8.0));

    const payload = {
      id: profile.id,
      name: profile.name || 'Student',
      email: profile.email,
      roll_number: profile.rollNumber || '',
      college: profile.college || 'Apex Institute of Technology',
      branch: profile.branch || 'Computer Science & Engineering',
      year_of_study: cleanYear,
      cgpa: cleanCgpa,
      graduation_year: Number(profile.graduationYear) || 2027,
      role: cleanRole,
      target_company_tier: cleanTier,
      phone: profile.phone || '',
      active_backlogs: Math.max(0, Number(profile.activeBacklogs) || 0),
      streak_days: Math.max(1, Number(profile.streakDays) || 1),
      completed_lessons_count: Math.max(0, Number(profile.completedLessonsCount) || 0),
      total_study_hours: Math.max(0, Number(profile.totalStudyHours) || 0),
      updated_at: new Date().toISOString(),
    };

    const { error } = await supabase.from('profiles').upsert(payload, { onConflict: 'id' });
    if (error) {
      console.warn('[Supabase] upsertProfile error:', error);
      return { success: false, error: error.message };
    }
    return { success: true };
  } catch (err: any) {
    console.warn('[Supabase] upsertProfile exception:', err);
    return { success: false, error: err?.message || 'Failed to save profile to database' };
  }
}

export async function fetchApplicationsFromSupabase(userId: string): Promise<Application[]> {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase
      .from('applications')
      .select('*')
      .eq('user_id', userId)
      .order('applied_date', { ascending: false });

    if (error || !data) return [];

    return data.map((item) => ({
      id: item.id,
      companyId: item.company_id,
      companyName: item.company_name,
      jobRole: item.job_role,
      appliedDate: item.applied_date,
      stage: item.stage,
      packageOffered: item.package_offered,
      nextRoundDate: item.next_round_date,
      notes: item.notes,
      location: item.location,
    }));
  } catch (err) {
    console.warn('[Supabase] fetchApplications error:', err);
    return [];
  }
}

export async function upsertApplicationToSupabase(
  app: Application,
  userId: string
): Promise<boolean> {
  if (!supabase) return false;
  try {
    const { error } = await supabase.from('applications').upsert(
      {
        id: app.id,
        user_id: userId,
        company_id: app.companyId,
        company_name: app.companyName,
        job_role: app.jobRole,
        applied_date: app.appliedDate,
        stage: app.stage,
        package_offered: app.packageOffered || null,
        next_round_date: app.nextRoundDate || null,
        notes: app.notes || null,
        location: app.location || null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'id' }
    );
    return !error;
  } catch (err) {
    console.warn('[Supabase] upsertApplication error:', err);
    return false;
  }
}

export async function deleteApplicationFromSupabase(appId: string): Promise<boolean> {
  if (!supabase) return false;
  try {
    const { error } = await supabase.from('applications').delete().eq('id', appId);
    return !error;
  } catch (err) {
    console.warn('[Supabase] deleteApplication error:', err);
    return false;
  }
}

export async function fetchQuizAttemptsFromSupabase(userId: string): Promise<QuizAttempt[]> {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase
      .from('quiz_attempts')
      .select('*')
      .eq('user_id', userId)
      .order('date', { ascending: false });

    if (error || !data) return [];

    return data.map((item) => ({
      id: item.id,
      title: item.title,
      category: item.category,
      score: item.score,
      totalQuestions: item.total_questions,
      percentage: parseFloat(item.percentage) || 0,
      passed: item.passed,
      date: item.date,
      timeSpentSeconds: item.time_spent_seconds || 0,
    }));
  } catch (err) {
    console.warn('[Supabase] fetchQuizAttempts error:', err);
    return [];
  }
}

export async function insertQuizAttemptToSupabase(
  attempt: QuizAttempt,
  userId: string
): Promise<boolean> {
  if (!supabase) return false;
  try {
    const { error } = await supabase.from('quiz_attempts').insert({
      id: attempt.id,
      user_id: userId,
      title: attempt.title,
      category: attempt.category,
      score: attempt.score,
      total_questions: attempt.totalQuestions,
      percentage: attempt.percentage,
      passed: attempt.passed,
      time_spent_seconds: attempt.timeSpentSeconds || 0,
      date: attempt.date,
    });
    return !error;
  } catch (err) {
    console.warn('[Supabase] insertQuizAttempt error:', err);
    return false;
  }
}

export interface UserProgressData {
  solvedAptitude: string[];
  solvedCoding: string[];
  completedLessons: string[];
  completedMilestones: string[];
  bookmarkedCompanies: string[];
}

export async function fetchUserProgressFromSupabase(
  userId: string
): Promise<UserProgressData | null> {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('user_progress')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error || !data) return null;

    return {
      solvedAptitude: Array.isArray(data.solved_aptitude) ? data.solved_aptitude : [],
      solvedCoding: Array.isArray(data.solved_coding) ? data.solved_coding : [],
      completedLessons: Array.isArray(data.completed_lessons) ? data.completed_lessons : [],
      completedMilestones: Array.isArray(data.completed_milestones)
        ? data.completed_milestones
        : [],
      bookmarkedCompanies: Array.isArray(data.bookmarked_companies)
        ? data.bookmarked_companies
        : [],
    };
  } catch (err) {
    console.warn('[Supabase] fetchUserProgress error:', err);
    return null;
  }
}

export async function upsertUserProgressToSupabase(
  userId: string,
  progress: Partial<UserProgressData>
): Promise<{ success: boolean; error?: string }> {
  if (!supabase) return { success: false, error: 'Supabase client not connected' };
  try {
    const { error } = await supabase.from('user_progress').upsert(
      {
        user_id: userId,
        solved_aptitude: progress.solvedAptitude || [],
        solved_coding: progress.solvedCoding || [],
        completed_lessons: progress.completedLessons || [],
        completed_milestones: progress.completedMilestones || [],
        bookmarked_companies: progress.bookmarkedCompanies || [],
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' }
    );
    if (error) {
      console.warn('[Supabase] upsertUserProgress error:', error);
      return { success: false, error: error.message };
    }
    return { success: true };
  } catch (err: any) {
    console.warn('[Supabase] upsertUserProgress exception:', err);
    return { success: false, error: err?.message || 'Failed to save progress to database' };
  }
}

export async function fetchCompaniesFromSupabase(): Promise<Company[]> {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase
      .from('companies')
      .select('*')
      .order('drive_date', { ascending: true });

    if (error || !data || data.length === 0) return [];

    return data.map((item) => ({
      id: item.id,
      name: item.name,
      tier: item.tier,
      jobRole: item.job_role,
      ctc: item.ctc,
      baseCtc: item.base_ctc,
      stipend: item.stipend,
      location: item.location,
      eligibility: item.eligibility,
      requiredSkills: item.required_skills || [],
      applicationDeadline: item.application_deadline,
      driveDate: item.drive_date,
      selectionRounds: item.selection_rounds || [],
      description: item.description,
      bondDetails: item.bond_details,
      pastInterviewQuestions: item.past_interview_questions || [],
      website: item.website,
    }));
  } catch (err) {
    console.warn('[Supabase] fetchCompanies error:', err);
    return [];
  }
}

export async function upsertCompanyToSupabase(company: Company): Promise<boolean> {
  if (!supabase) return false;
  try {
    const { error } = await supabase.from('companies').upsert(
      {
        id: company.id,
        name: company.name,
        tier: company.tier,
        job_role: company.jobRole,
        ctc: company.ctc,
        base_ctc: company.baseCtc || null,
        stipend: company.stipend || null,
        location: company.location,
        eligibility: company.eligibility,
        required_skills: company.requiredSkills || [],
        application_deadline: company.applicationDeadline,
        drive_date: company.driveDate,
        selection_rounds: company.selectionRounds || [],
        description: company.description,
        bond_details: company.bondDetails || null,
        past_interview_questions: company.pastInterviewQuestions || [],
        website: company.website || null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'id' }
    );
    return !error;
  } catch (err) {
    console.warn('[Supabase] upsertCompany error:', err);
    return false;
  }
}

export async function deleteCompanyFromSupabase(companyId: string): Promise<boolean> {
  if (!supabase) return false;
  try {
    const { error } = await supabase.from('companies').delete().eq('id', companyId);
    return !error;
  } catch (err) {
    console.warn('[Supabase] deleteCompany error:', err);
    return false;
  }
}

export async function fetchNoticesFromSupabase(): Promise<Notice[]> {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase
      .from('notices')
      .select('*')
      .order('date', { ascending: false });

    if (error || !data || data.length === 0) return [];

    return data.map((item) => ({
      id: item.id,
      title: item.title,
      content: item.content,
      date: item.date,
      urgent: item.urgent,
      author: item.author,
      category: item.category,
    }));
  } catch (err) {
    console.warn('[Supabase] fetchNotices error:', err);
    return [];
  }
}

export async function upsertNoticeToSupabase(notice: Notice): Promise<boolean> {
  if (!supabase) return false;
  try {
    const { error } = await supabase.from('notices').upsert(
      {
        id: notice.id,
        title: notice.title,
        content: notice.content,
        date: notice.date,
        urgent: notice.urgent,
        author: notice.author,
        category: notice.category,
      },
      { onConflict: 'id' }
    );
    return !error;
  } catch (err) {
    console.warn('[Supabase] upsertNotice error:', err);
    return false;
  }
}

export async function deleteNoticeFromSupabase(noticeId: string): Promise<boolean> {
  if (!supabase) return false;
  try {
    const { error } = await supabase.from('notices').delete().eq('id', noticeId);
    return !error;
  } catch (err) {
    console.warn('[Supabase] deleteNotice error:', err);
    return false;
  }
}
