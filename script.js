import {
  auth_service_instance,
  google_auth_provider,
  firestore_database_instance,
} from './firebase-config.js';
import {
  browserLocalPersistence,
  signInWithPopup,
  onAuthStateChanged,
  setPersistence,
  signOut,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
  doc,
  getDoc,
  setDoc,
  deleteDoc,
  collection,
  onSnapshot
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const GUEST_STORAGE_KEY = 'college_tracker_guest_data_v1';
const GUEST_SESSION_KEY = 'college_tracker_guest_session_active';

function create_default_user_preferences() {
  return { default_module: 'attendance', open_sidebar_on_startup: true };
}

let is_initial_auth_resolved = false;
let auth_timeout_id = setTimeout(() => {
  if (!is_initial_auth_resolved) {
    is_initial_auth_resolved = true;
    const loading_overlay = document.getElementById('auth_loading_overlay');
    const login_screen = document.getElementById('login_screen');
    const main_app = document.getElementById('main_app');

    if (loading_overlay) loading_overlay.classList.remove('active');
    if (login_screen) login_screen.classList.remove('hidden');
    if (main_app) main_app.classList.add('hidden');
  }
}, 5000);

const application_state = {
  enrolled_subjects: [],
  weekly_schedule_slots: [],
  additional_extra_classes: [],
  attendance_records: [],
  assignments: [],
  start_of_current_week: null,
  current_mobile_date_object: new Date(),
  mobile_view_mode: 'day',
  user_preferences: create_default_user_preferences()
};

let currently_editing_subject_identifier = null;
let currently_editing_assignment_identifier = null;
let current_logged_in_user = null;
let is_guest_user = false;
let firestore_unsubscribers = [];
let pending_guest_upgrade_user = null;
let pending_guest_upgrade_data = null;

const WEEK_DAYS_ARRAY = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
];
const THEME_COLORS_ARRAY = [
  '#7c5cff',
  '#3498db',
  '#2ecc71',
  '#f1c40f',
  '#e67e22',
  '#e74c3c',
  '#e84393',
  '#9b59b6',
  '#1abc9c',
  '#00cec9',
];

const PERSISTED_COLLECTION_DEFINITIONS = [
  { name: 'subjects', stateKey: 'enrolled_subjects', idKey: 'subject_identifier' },
  { name: 'weekly_slots', stateKey: 'weekly_schedule_slots', idKey: 'slot_identifier' },
  { name: 'extra_classes', stateKey: 'additional_extra_classes', idKey: 'extra_class_identifier' },
  { name: 'attendance_records', stateKey: 'attendance_records', idKey: 'attendance_identifier' },
  { name: 'assignments', stateKey: 'assignments', idKey: 'assignment_identifier' }
];

function get_persisted_collection_definition(collection_name) {
  return PERSISTED_COLLECTION_DEFINITIONS.find(definition => definition.name === collection_name);
}

function is_running_as_installed_pwa() {
  return window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    window.navigator.standalone === true;
}

function update_guest_button_visibility() {
  const guest_button = document.getElementById('guest_mode_btn');
  if (!guest_button) return;
  guest_button.classList.remove('hidden');
}

function read_guest_storage_snapshot() {
  let stored_guest_data = {};

  try {
    stored_guest_data = JSON.parse(localStorage.getItem(GUEST_STORAGE_KEY) || '{}') || {};
  } catch (error) {
    stored_guest_data = {};
  }

  return {
    enrolled_subjects: Array.isArray(stored_guest_data.enrolled_subjects) ? stored_guest_data.enrolled_subjects : [],
    weekly_schedule_slots: Array.isArray(stored_guest_data.weekly_schedule_slots) ? stored_guest_data.weekly_schedule_slots : [],
    additional_extra_classes: Array.isArray(stored_guest_data.additional_extra_classes) ? stored_guest_data.additional_extra_classes : [],
    attendance_records: Array.isArray(stored_guest_data.attendance_records) ? stored_guest_data.attendance_records : [],
    assignments: Array.isArray(stored_guest_data.assignments) ? stored_guest_data.assignments : [],
    user_preferences: {
      ...create_default_user_preferences(),
      ...(stored_guest_data.user_preferences || {})
    }
  };
}

function guest_storage_has_data(guest_data = read_guest_storage_snapshot()) {
  const default_preferences = create_default_user_preferences();
  return guest_data.enrolled_subjects.length > 0 ||
    guest_data.weekly_schedule_slots.length > 0 ||
    guest_data.additional_extra_classes.length > 0 ||
    guest_data.attendance_records.length > 0 ||
    guest_data.assignments.length > 0 ||
    guest_data.user_preferences.default_module !== default_preferences.default_module ||
    guest_data.user_preferences.open_sidebar_on_startup !== default_preferences.open_sidebar_on_startup;
}

function save_guest_application_state() {
  if (!is_guest_user) return;

  localStorage.setItem(GUEST_STORAGE_KEY, JSON.stringify({
    enrolled_subjects: application_state.enrolled_subjects,
    weekly_schedule_slots: application_state.weekly_schedule_slots,
    additional_extra_classes: application_state.additional_extra_classes,
    attendance_records: application_state.attendance_records,
    assignments: application_state.assignments,
    user_preferences: application_state.user_preferences
  }));
  localStorage.setItem(GUEST_SESSION_KEY, 'true');
}

function load_guest_application_state() {
  const guest_data = read_guest_storage_snapshot();
  application_state.enrolled_subjects = guest_data.enrolled_subjects;
  application_state.weekly_schedule_slots = guest_data.weekly_schedule_slots;
  application_state.additional_extra_classes = guest_data.additional_extra_classes;
  application_state.attendance_records = guest_data.attendance_records;
  application_state.assignments = guest_data.assignments;
  application_state.user_preferences = guest_data.user_preferences;
}

function clear_guest_local_data() {
  localStorage.removeItem(GUEST_STORAGE_KEY);
  localStorage.removeItem(GUEST_SESSION_KEY);
}

function update_sidebar_auth_action() {
  const auth_action_button = document.getElementById('sidebar_auth_action_btn');
  const auth_action_text = document.getElementById('sidebar_auth_action_text');
  const guest_logout_button = document.getElementById('guest_logout_btn');
  const settings_button = document.getElementById('sidebar_settings_btn');
  const google_icon = document.getElementById('sidebar_google_icon');
  const logout_icon = document.getElementById('sidebar_logout_icon');
  if (!auth_action_button || !auth_action_text) return;

  if (is_guest_user) {
    auth_action_button.title = 'Sign in with Google';
    auth_action_text.innerText = 'Sign in to save data';
    guest_logout_button?.classList.remove('hidden');
    settings_button?.classList.add('hidden');
    google_icon?.classList.remove('hidden');
    logout_icon?.classList.add('hidden');
  } else {
    auth_action_button.title = 'Logout';
    auth_action_text.innerText = 'Logout';
    guest_logout_button?.classList.add('hidden');
    settings_button?.classList.remove('hidden');
    google_icon?.classList.add('hidden');
    logout_icon?.classList.remove('hidden');
  }
}

function render_authenticated_shell(welcome_text) {
  const login_screen = document.getElementById('login_screen');
  const main_app = document.getElementById('main_app');
  const user_welcome_text = document.getElementById('user_welcome_text');

  login_screen.classList.add('hidden');
  main_app.classList.remove('hidden');
  user_welcome_text.innerText = welcome_text;

  application_state.start_of_current_week = calculate_monday_of_target_week(new Date());
  application_state.current_mobile_date_object = new Date();
  initialize_color_selection_palette();
  update_sidebar_auth_action();
}

function apply_startup_preferences(forced_module_name = null) {
  switch_module(forced_module_name || application_state.user_preferences.default_module || 'attendance');

  if (window.innerWidth <= 1000) {
    if (application_state.user_preferences.open_sidebar_on_startup !== false) {
      document.querySelector('.sidebar').classList.add('active');
      const overlay = document.getElementById('mobile_sidebar_overlay');
      if (overlay) {
        overlay.classList.add('active');
      }
    }
  }

  setTimeout(scroll_interface_to_current_time_slot, 100);
}

function persist_collection_record(collection_name, document_identifier, record_data, options = {}) {
  if (is_guest_user) {
    const collection_definition = get_persisted_collection_definition(collection_name);
    if (!collection_definition) return Promise.resolve();

    const state_collection = application_state[collection_definition.stateKey];
    const existing_index = state_collection.findIndex(
      item => item[collection_definition.idKey] === document_identifier
    );
    const next_record = options.merge && existing_index >= 0
      ? { ...state_collection[existing_index], ...record_data }
      : record_data;

    if (existing_index >= 0) {
      state_collection[existing_index] = next_record;
    } else {
      state_collection.push(next_record);
    }

    save_guest_application_state();
    render_entire_application_interface();
    return Promise.resolve();
  }

  if (!current_logged_in_user) return Promise.resolve();
  return setDoc(
    doc(firestore_database_instance, `users/${current_logged_in_user.uid}/${collection_name}/${document_identifier}`),
    record_data,
    options
  );
}

function delete_collection_record(collection_name, document_identifier) {
  if (is_guest_user) {
    const collection_definition = get_persisted_collection_definition(collection_name);
    if (!collection_definition) return Promise.resolve();

    application_state[collection_definition.stateKey] =
      application_state[collection_definition.stateKey].filter(
        item => item[collection_definition.idKey] !== document_identifier
      );

    save_guest_application_state();
    render_entire_application_interface();
    return Promise.resolve();
  }

  if (!current_logged_in_user) return Promise.resolve();
  return deleteDoc(
    doc(firestore_database_instance, `users/${current_logged_in_user.uid}/${collection_name}/${document_identifier}`)
  );
}

function persist_user_preferences() {
  if (is_guest_user) {
    save_guest_application_state();
    return Promise.resolve();
  }

  if (!current_logged_in_user) return Promise.resolve();
  return setDoc(
    doc(firestore_database_instance, `users/${current_logged_in_user.uid}/settings/preferences`),
    application_state.user_preferences,
    { merge: true }
  );
}

async function save_guest_snapshot_to_firestore(user, guest_data) {
  const writes = [];

  PERSISTED_COLLECTION_DEFINITIONS.forEach(collection_definition => {
    guest_data[collection_definition.stateKey].forEach(record_item => {
      writes.push(setDoc(
        doc(
          firestore_database_instance,
          `users/${user.uid}/${collection_definition.name}/${record_item[collection_definition.idKey]}`
        ),
        record_item,
        { merge: true }
      ));
    });
  });

  writes.push(setDoc(
    doc(firestore_database_instance, `users/${user.uid}/settings/preferences`),
    guest_data.user_preferences,
    { merge: true }
  ));

  await Promise.all(writes);
}

function show_guest_upgrade_modal(user, guest_data) {
  pending_guest_upgrade_user = user;
  pending_guest_upgrade_data = guest_data;
  document.getElementById('guest_upgrade_modal')?.classList.add('active');
}

function setup_firestore_listeners() {
  if (is_guest_user || !current_logged_in_user) return;
  const uid = current_logged_in_user.uid;

  PERSISTED_COLLECTION_DEFINITIONS.forEach(col => {
    const colRef = collection(firestore_database_instance, `users/${uid}/${col.name}`);
    const unsub = onSnapshot(colRef, (snapshot) => {
      application_state[col.stateKey] = snapshot.docs.map(doc => doc.data());
      render_entire_application_interface();
      render_assignments();
    });
    firestore_unsubscribers.push(unsub);
  });
}

function clear_firestore_listeners() {
  firestore_unsubscribers.forEach(unsub => unsub());
  firestore_unsubscribers = [];
}

window.handle_auth_click = async function () {
  const loading_overlay = document.getElementById('auth_loading_overlay');
  const loading_text = document.getElementById('auth_loading_text');

  if (current_logged_in_user && !is_guest_user) {
    loading_text.innerText = 'Signing out...';
    loading_overlay.classList.add('active');
    try {
      await signOut(auth_service_instance);
    } catch (e) {
      loading_overlay.classList.remove('active');
    }
  } else {
    loading_text.innerText = is_guest_user ? 'Signing in with Google...' : 'Signing in...';
    loading_overlay.classList.add('active');
    try {
      await setPersistence(auth_service_instance, browserLocalPersistence);
      await signInWithPopup(auth_service_instance, google_auth_provider);
    } catch (e) {
      loading_overlay.classList.remove('active');
    }
  }
};

window.enter_guest_mode = function () {
  localStorage.setItem(GUEST_SESSION_KEY, 'true');
  start_guest_session();
};

window.exit_guest_mode = function () {
  localStorage.removeItem(GUEST_SESSION_KEY);
  is_guest_user = false;
  current_logged_in_user = null;

  document.getElementById('login_screen')?.classList.remove('hidden');
  document.getElementById('main_app')?.classList.add('hidden');
  document.querySelector('.sidebar')?.classList.remove('active');
  document.getElementById('mobile_sidebar_overlay')?.classList.remove('active');
  window.close_all_interface_modals?.();
  reset_application_state_to_default();
  update_sidebar_auth_action();
};

function reset_application_state_to_default() {
  clear_firestore_listeners();
  application_state.enrolled_subjects = [];
  application_state.weekly_schedule_slots = [];
  application_state.additional_extra_classes = [];
  application_state.attendance_records = [];
  application_state.assignments = [];
  application_state.user_preferences = create_default_user_preferences();
  render_entire_application_interface();
  render_assignments();
}

function start_guest_session() {
  clear_firestore_listeners();
  current_logged_in_user = null;
  is_guest_user = true;
  load_guest_application_state();
  render_authenticated_shell('Welcome, Guest');
  apply_startup_preferences('attendance');

  const loading_overlay = document.getElementById('auth_loading_overlay');
  if (loading_overlay) {
    loading_overlay.classList.remove('active');
  }
}

async function start_authenticated_session(user) {
  clear_firestore_listeners();
  is_guest_user = false;
  current_logged_in_user = user;
  localStorage.removeItem(GUEST_SESSION_KEY);
  application_state.enrolled_subjects = [];
  application_state.weekly_schedule_slots = [];
  application_state.additional_extra_classes = [];
  application_state.attendance_records = [];
  application_state.assignments = [];
  application_state.user_preferences = create_default_user_preferences();
  const display_name = user.displayName || 'Student';
  render_authenticated_shell(`Welcome, ${display_name.split(' ')[0]}`);

  setup_firestore_listeners();

  const prefRef = doc(firestore_database_instance, `users/${user.uid}/settings/preferences`);
  const prefSnap = await getDoc(prefRef);
  if (prefSnap.exists()) {
    application_state.user_preferences = prefSnap.data();
    if (typeof application_state.user_preferences.open_sidebar_on_startup === 'undefined') {
      application_state.user_preferences.open_sidebar_on_startup = true;
    }
  } else {
    application_state.user_preferences = create_default_user_preferences();
  }

  apply_startup_preferences();
}

function calculate_monday_of_target_week(target_date_object) {
  const copied_date_object = new Date(target_date_object);
  const day_of_week_index = copied_date_object.getDay();
  const date_difference_value =
    copied_date_object.getDate() -
    day_of_week_index +
    (day_of_week_index === 0 ? -6 : 1);
  copied_date_object.setDate(date_difference_value);
  copied_date_object.setHours(0, 0, 0, 0);
  return copied_date_object;
}

function format_date_to_string_format(date_object_to_format) {
  const year_numerical_value = date_object_to_format.getFullYear();
  const month_numerical_value = String(
    date_object_to_format.getMonth() + 1,
  ).padStart(2, '0');
  const day_numerical_value = String(date_object_to_format.getDate()).padStart(
    2,
    '0',
  );
  return `${year_numerical_value}-${month_numerical_value}-${day_numerical_value}`;
}

function generate_unique_random_identifier(identifier_prefix_string) {
  return `${identifier_prefix_string}_${Math.random().toString(36).substr(2, 9)}`;
}

function retrieve_subject_object_by_identifier(target_subject_identifier) {
  return application_state.enrolled_subjects.find(
    subject_item =>
      subject_item.subject_identifier === target_subject_identifier,
  );
}

function gather_lectures_for_date(target_date_string, derived_day_name_string) {
  let compiled_lectures_array = [];
  application_state.weekly_schedule_slots.forEach(slot_item => {
    if (slot_item.day_of_week_name === derived_day_name_string) {
      compiled_lectures_array.push({
        lecture_type_string: 'slot',
        lecture_identifier: slot_item.slot_identifier,
        parent_subject_identifier: slot_item.parent_subject_identifier,
        start_time_hour_value: slot_item.start_time_hour_value,
        lecture_duration_value: slot_item.lecture_duration_value,
      });
    }
  });
  application_state.additional_extra_classes.forEach(extra_class_item => {
    if (extra_class_item.lecture_date_string === target_date_string) {
      compiled_lectures_array.push({
        lecture_type_string: 'extra',
        lecture_identifier: extra_class_item.extra_class_identifier,
        parent_subject_identifier: extra_class_item.parent_subject_identifier,
        start_time_hour_value: extra_class_item.start_time_hour_value,
        lecture_duration_value: extra_class_item.lecture_duration_value,
      });
    }
  });
  compiled_lectures_array.sort(
    (a, b) => a.start_time_hour_value - b.start_time_hour_value,
  );
  return compiled_lectures_array;
}

window.switch_module = function (module_name) {
  sessionStorage.setItem('active_module', module_name);

  document.querySelectorAll('.switcher-btn').forEach(btn => {
    btn.classList.remove('active');
  });
  document.querySelectorAll('.module-content').forEach(content => {
    content.classList.add('hidden');
    content.classList.remove('active');
  });

  const active_btn = document.querySelector(`[data-target="module-${module_name}"]`);
  const active_content = document.getElementById(`module-${module_name}`);
  const slider = document.getElementById('switcher_slider');

  if (active_btn) {
    active_btn.classList.add('active');
    if (slider) {
      slider.style.transform = module_name === 'assignments' ? 'translateX(100%)' : 'translateX(0)';
    }
  }

  if (active_content) {
    active_content.classList.remove('hidden');
    setTimeout(() => {
        active_content.classList.add('active');
    }, 10);
  }

  render_attendance_statistics_cards();

  if (module_name === 'assignments') {
    render_assignments();
  } else if (module_name === 'attendance') {
    if (window.innerWidth <= 1000) {
      render_mobile_interface();
    } else {
      render_weekly_calendar_grid();
    }
  }
};

function get_assignment_status_data(assignment, is_completed) {
  const today_date = new Date();
  today_date.setHours(0, 0, 0, 0);
  const due_date = new Date(assignment.due_date_string);
  due_date.setHours(0, 0, 0, 0);
  const diff_days = Math.round((due_date - today_date) / 86400000);

  let time_remaining_text = '';
  let is_overdue = false;

  if (is_completed) {
    time_remaining_text = '-';
  } else if (diff_days < 0) {
    time_remaining_text = `Overdue by ${Math.abs(diff_days)} day${Math.abs(diff_days) > 1 ? 's' : ''}`;
    is_overdue = true;
  } else if (diff_days === 0) {
    time_remaining_text = 'Due Today';
  } else if (diff_days === 1) {
    time_remaining_text = 'Tomorrow';
  } else {
    time_remaining_text = `${diff_days} days left`;
  }

  return { time_remaining_text, is_overdue };
}

function build_assignment_table_html(assignments_array, is_completed) {
  if (assignments_array.length === 0) {
    return `<div style="color: var(--text-muted); font-size: 13px; text-align: center; padding: 20px;">No ${is_completed ? 'completed' : 'pending'} assignments.</div>`;
  }

  let table_html = `
    <div class="table-responsive">
      <table class="assignments-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Subject</th>
            <th>Priority</th>
            <th>Due Date</th>
            <th>Time Remaining</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
  `;

  assignments_array.forEach(assignment => {
    const parent_subject = retrieve_subject_object_by_identifier(assignment.parent_subject_identifier);
    if (!parent_subject) return;

    const { time_remaining_text, is_overdue } = get_assignment_status_data(assignment, is_completed);
    const row_class = is_overdue && !is_completed ? 'overdue-row' : '';
    const time_class = is_overdue && !is_completed ? 'overdue-text' : '';

    table_html += `
      <tr class="${row_class}">
        <td style="font-weight: 500;">${assignment.assignment_name}</td>
        <td>
          <span class="subject-code" style="color: ${parent_subject.subject_color_hex || 'var(--accent)'}; background: ${parent_subject.subject_color_hex ? parent_subject.subject_color_hex + '1A' : 'rgba(124, 92, 255, 0.1)'};">
            ${parent_subject.subject_code_text}
          </span>
        </td>
        <td><span class="priority-badge priority-${assignment.priority_level}">${assignment.priority_level}</span></td>
        <td style="color: var(--text-muted);">${assignment.due_date_string}</td>
        <td><span class="${time_class}">${time_remaining_text}</span></td>
        <td><span style="color: var(--text-muted);">${assignment.completion_status}</span></td>
        <td>
          <div style="display: flex; gap: 6px;">
            <button class="btn btn-secondary" style="width: auto; padding: 6px 12px; font-size: 11px;" onclick="toggle_assignment_status('${assignment.assignment_identifier}')">
              ${assignment.completion_status === 'Pending' ? 'Complete' : 'Undo'}
            </button>
            <button class="btn btn-secondary" style="width: auto; padding: 6px 12px; font-size: 11px;" onclick="open_assignment_modal('${assignment.assignment_identifier}')">
              Edit
            </button>
            <button class="icon-btn delete-btn" style="margin-left: 0; padding: 6px;" onclick="delete_assignment('${assignment.assignment_identifier}')">✖</button>
          </div>
        </td>
      </tr>
    `;
  });

  table_html += `
        </tbody>
      </table>
    </div>
  `;
  return table_html;
}

function build_assignment_cards_html(assignments_array, is_completed) {
  if (assignments_array.length === 0) {
    return `<div style="color: var(--text-muted); font-size: 13px; text-align: center; padding: 20px;">No ${is_completed ? 'completed' : 'pending'} assignments.</div>`;
  }

  let html = '';

  assignments_array.forEach(assignment => {
    const parent_subject = retrieve_subject_object_by_identifier(assignment.parent_subject_identifier);
    if (!parent_subject) return;

    const { time_remaining_text, is_overdue } = get_assignment_status_data(assignment, is_completed);
    const card_class = is_overdue && !is_completed ? 'assignment-card overdue' : 'assignment-card';
    const time_class = is_overdue && !is_completed ? 'overdue-text' : '';

    html += `
      <div class="${card_class}">
        <div class="assignment-card-header">
          <div class="assignment-card-title">${assignment.assignment_name}</div>
          <span class="priority-badge priority-${assignment.priority_level}">${assignment.priority_level}</span>
        </div>
        <div class="assignment-card-meta">
          <span class="subject-code" style="color: ${parent_subject.subject_color_hex || 'var(--accent)'}; background: ${parent_subject.subject_color_hex ? parent_subject.subject_color_hex + '1A' : 'rgba(124, 92, 255, 0.1)'}; margin: 0;">
            ${parent_subject.subject_code_text}
          </span>
          <span>Due: ${assignment.due_date_string}</span>
        </div>
        ${!is_completed ? `<div class="${time_class}" style="font-size: 12px;">${time_remaining_text}</div>` : ''}
        <div class="assignment-card-actions">
          <button class="btn btn-secondary" style="width: auto; padding: 6px 12px; font-size: 11px;" onclick="toggle_assignment_status('${assignment.assignment_identifier}')">
            ${assignment.completion_status === 'Pending' ? 'Complete' : 'Undo'}
          </button>
          <button class="btn btn-secondary" style="width: auto; padding: 6px 12px; font-size: 11px;" onclick="open_assignment_modal('${assignment.assignment_identifier}')">
            Edit
          </button>
          <button class="icon-btn delete-btn" style="margin-left: 0; padding: 6px;" onclick="delete_assignment('${assignment.assignment_identifier}')">✖</button>
        </div>
      </div>
    `;
  });

  return html;
}

window.render_assignments = function () {
  const pending_list = document.getElementById('pending_assignments_list');
  const completed_list = document.getElementById('completed_assignments_list');

  if (!pending_list || !completed_list) return;

  let assignments_to_render = [...application_state.assignments];

  assignments_to_render.sort(
    (a, b) => new Date(a.due_date_string) - new Date(b.due_date_string)
  );

  const pending_assignments = assignments_to_render.filter(
    a => a.completion_status === 'Pending'
  );

  const completed_assignments = assignments_to_render.filter(
    a => a.completion_status === 'Completed'
  );

  if (window.innerWidth <= 768) {
    pending_list.innerHTML = build_assignment_cards_html(pending_assignments, false);
    completed_list.innerHTML = build_assignment_cards_html(completed_assignments, true);
  } else {
    pending_list.innerHTML = build_assignment_table_html(pending_assignments, false);
    completed_list.innerHTML = build_assignment_table_html(completed_assignments, true);
  }
};

window.toggle_assignment_status = function (assignment_identifier) {
  const assignment = application_state.assignments.find(a => a.assignment_identifier === assignment_identifier);
  if (assignment) {
    const new_status = assignment.completion_status === 'Pending' ? 'Completed' : 'Pending';
    persist_collection_record('assignments', assignment_identifier, { ...assignment, completion_status: new_status }, { merge: true });
  }
};

window.delete_assignment = function (assignment_identifier) {
  show_custom_confirm(
    'Delete this assignment? This action cannot be undone.',
    () => {
      delete_collection_record('assignments', assignment_identifier);
    }
  );
};

window.open_assignment_modal = function(assignment_identifier = null) {
  currently_editing_assignment_identifier = assignment_identifier;
  const title_element = document.getElementById('assignment_modal_title');
  const submit_button = document.getElementById('assignment_submit_btn');
  const form = document.getElementById('assignment_input_form');
  
  form.reset();

  if (assignment_identifier) {
    const assignment = application_state.assignments.find(a => a.assignment_identifier === assignment_identifier);
    if (assignment) {
      title_element.innerText = 'Edit Assignment';
      submit_button.innerText = 'Save Changes';
      document.getElementById('assignment_name_input').value = assignment.assignment_name;
      document.getElementById('assignment_subject_selection').value = assignment.parent_subject_identifier;
      document.getElementById('assignment_priority_selection').value = assignment.priority_level;
      document.getElementById('assignment_due_date_input').value = assignment.due_date_string;
    }
  } else {
    title_element.innerText = 'Add Assignment';
    submit_button.innerText = 'Save';
  }
  
  open_interface_modal('add_assignment_modal');
};

document.getElementById('assignment_input_form').addEventListener('submit', form_submit_event => {
  form_submit_event.preventDefault();
  
  const name = document.getElementById('assignment_name_input').value.trim();
  const subject = document.getElementById('assignment_subject_selection').value;
  const priority = document.getElementById('assignment_priority_selection').value;
  const due_date = document.getElementById('assignment_due_date_input').value;

  if (currently_editing_assignment_identifier) {
    const assignment = application_state.assignments.find(a => a.assignment_identifier === currently_editing_assignment_identifier);
    if (assignment) {
      persist_collection_record('assignments', currently_editing_assignment_identifier, {
        ...assignment,
        assignment_name: name,
        parent_subject_identifier: subject,
        priority_level: priority,
        due_date_string: due_date
      }, { merge: true });
    }
  } else {
    const new_id = generate_unique_random_identifier('asn');
    persist_collection_record('assignments', new_id, {
      assignment_identifier: new_id,
      assignment_name: name,
      parent_subject_identifier: subject,
      priority_level: priority,
      due_date_string: due_date,
      completion_status: 'Pending',
      reminder_configured: false,
      reminder_threshold_minutes: 0
    });
  }

  close_all_interface_modals();
});

function render_entire_application_interface() {
  render_attendance_statistics_cards();
  update_dropdown_selection_options();
  if (window.innerWidth <= 1000) {
    render_mobile_interface();
  } else {
    render_weekly_calendar_grid();
  }
  render_assignments();
}

function render_attendance_statistics_cards() {
  const statistics_list_container = document.getElementById(
    'stats_list_container',
  );
  if (!statistics_list_container) return;

  statistics_list_container.innerHTML = '';
  const active_module = sessionStorage.getItem('active_module') || 'attendance';

  application_state.enrolled_subjects.forEach(current_subject_data => {
    let card_content_html = '';

    if (active_module === 'attendance') {
      let total_present_hours_count = 0;
      let total_scheduled_hours_count = 0;
      let total_cancelled_hours_count = 0;

      const target_val = current_subject_data.target_percentage || 75;
      const target_dec = target_val / 100;

      application_state.attendance_records.forEach(attendance_record_item => {
        if (
          attendance_record_item.parent_subject_identifier ===
          current_subject_data.subject_identifier
        ) {
          attendance_record_item.lecture_status_array.forEach(
            attendance_status_value => {
              if (attendance_status_value === 'P') {
                total_present_hours_count++;
                total_scheduled_hours_count++;
              } else if (attendance_status_value === 'A') {
                total_scheduled_hours_count++;
              } else if (attendance_status_value === 'C') {
                total_cancelled_hours_count++;
              }
            },
          );
        }
      });

      const calculated_attendance_percentage =
        total_scheduled_hours_count === 0
          ? 0
          : (
            (total_present_hours_count / total_scheduled_hours_count) *
            100
          ).toFixed(1);
      let dynamic_target_text_output = '';

      if (total_scheduled_hours_count === 0) {
        dynamic_target_text_output = `<span style="color: var(--text-muted);">No classes yet</span>`;
      } else if (calculated_attendance_percentage >= target_val) {
        let skippable_lecture_hours_count = 0;
        if (target_dec > 0) {
          skippable_lecture_hours_count = Math.floor(
            (total_present_hours_count -
              target_dec * total_scheduled_hours_count) /
            target_dec,
          );
        } else {
          skippable_lecture_hours_count = 999;
        }

        if (skippable_lecture_hours_count > 0) {
          dynamic_target_text_output = `<span style="color: var(--present); font-weight: 600;">Safe (Can skip ${skippable_lecture_hours_count} hrs)</span>`;
        } else {
          dynamic_target_text_output = `<span style="color: var(--present); font-weight: 600;">Safe (Cannot skip any)</span>`;
        }
      } else {
        let required_lecture_hours_count = 0;
        if (target_dec < 1) {
          required_lecture_hours_count = Math.ceil(
            (target_dec * total_scheduled_hours_count -
              total_present_hours_count) /
            (1 - target_dec),
          );
          dynamic_target_text_output = `<span style="color: var(--cancelled); font-weight: 600;">Need ${required_lecture_hours_count} lecture hrs</span>`;
        } else {
          dynamic_target_text_output = `<span style="color: var(--cancelled); font-weight: 600;">Cannot reach 100%</span>`;
        }
      }

      card_content_html = `
        <div class="stat-row"><span>Present:</span> <span>${total_present_hours_count}</span></div>
        <div class="stat-row"><span>Total:</span> <span>${total_scheduled_hours_count}</span></div>
        <div class="stat-row"><span>Target:</span> <span>${target_val}%</span></div>
        <div style="display: flex; justify-content: space-between; align-items: flex-end; margin-top: 8px;">
          <div class="stat-perc" style="color: ${current_subject_data.subject_color_hex || 'var(--accent)'}; margin-top: 0;">${calculated_attendance_percentage}%</div>
          <div class="target-text-output" style="font-size: 10px;">${dynamic_target_text_output}</div>
        </div>
      `;
    } else {
      let total_assignments_count = 0;
      let due_soon_count = 0;
      let overdue_count = 0;

      const today_date = new Date();
      today_date.setHours(0, 0, 0, 0);

      application_state.assignments.forEach(assignment => {
        if (assignment.parent_subject_identifier === current_subject_data.subject_identifier) {
          total_assignments_count++;
          if (assignment.completion_status === 'Pending') {
            const due_date = new Date(assignment.due_date_string);
            due_date.setHours(0, 0, 0, 0);
            const diff_days = Math.round((due_date - today_date) / 86400000);

            if (diff_days < 0) {
              overdue_count++;
            } else if (diff_days >= 0 && diff_days <= 7) {
              due_soon_count++;
            }
          }
        }
      });

      if (total_assignments_count === 0) {
        card_content_html =
          `<div class="assignment-empty-state" style="color: var(--text-muted); padding: 10px 0; font-size: 12px; text-align: center;">
          No Assignments
          </div>`;
      } else {
        card_content_html = `
    <div class="stat-row"><span>Total Assignments:</span> <span>${total_assignments_count}</span></div>
    <div class="stat-row"><span>Due Soon:</span> <span style="color: var(--cancelled); font-weight: 600;">${due_soon_count}</span></div>
    <div class="stat-row"><span>Overdue:</span> <span style="color: var(--absent); font-weight: 600;">${overdue_count}</span></div>
  `;
      }
    }

    statistics_list_container.innerHTML += `
      <div class="stat-card" style="border-left: 4px solid ${current_subject_data.subject_color_hex || 'var(--accent)'}">
        <div class="subject-header" style="align-items: flex-start;">
          <div class="subject-name-text" style="font-weight:600; color:var(--text); flex: 1; padding-right: 12px; word-break: break-word;">${current_subject_data.subject_name_text}</div>
          <div class="card-actions">
            <span class="subject-code" style="color: ${current_subject_data.subject_color_hex || 'var(--accent)'}; background: ${current_subject_data.subject_color_hex ? current_subject_data.subject_color_hex + '1A' : 'rgba(124, 92, 255, 0.1)'}; margin-left: 0; margin-right: 4px;">${current_subject_data.subject_code_text}</span>
            <button class="icon-btn edit-btn" onclick="open_edit_subject_modal('${current_subject_data.subject_identifier}')" title="Edit Subject">Edit</button>
            <button class="icon-btn delete-btn" onclick="delete_selected_subject_data('${current_subject_data.subject_identifier}')" title="Delete Subject">✖</button>
          </div>
        </div>
        ${card_content_html}
      </div>
    `;
  });
}

function render_weekly_calendar_grid() {
  document.getElementById('calendar_header_container').style.display = 'grid';
  document.getElementById('calendar_body_container').style.display = 'grid';
  const mobile_container = document.getElementById('mobile_view_container');
  if (mobile_container) mobile_container.style.display = 'none';

  const calendar_header_container_element = document.getElementById(
    'calendar_header_container',
  );
  const calendar_body_container_element = document.getElementById(
    'calendar_body_container',
  );
  const actual_current_date_string = format_date_to_string_format(new Date());

  const month_names_array = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  if (!application_state.start_of_current_week) {
    application_state.start_of_current_week = new Date();
  }
  document.getElementById('current_week_display_label').innerText =
    `${month_names_array[application_state.start_of_current_week.getMonth()]} ${application_state.start_of_current_week.getFullYear()}`;

  const desktop_date_selection_input = document.getElementById(
    'desktop_date_selection',
  );
  if (desktop_date_selection_input) {
    desktop_date_selection_input.value = format_date_to_string_format(
      application_state.start_of_current_week,
    );
  }

  calendar_header_container_element.innerHTML = `<div class="day-col-header" style="justify-content: center;">Time</div>`;
  let current_week_dates_array = [];
  for (let iteration_index = 0; iteration_index < 5; iteration_index++) {
    let calculated_date_object = new Date(
      application_state.start_of_current_week,
    );
    calculated_date_object.setDate(
      calculated_date_object.getDate() + iteration_index,
    );
    const formatted_date_string_value = format_date_to_string_format(
      calculated_date_object,
    );
    current_week_dates_array.push(formatted_date_string_value);

    const is_current_day_boolean =
      formatted_date_string_value === actual_current_date_string;
    const dynamic_today_header_class = is_current_day_boolean
      ? 'today-header'
      : '';
    const dynamic_today_badge_html = is_current_day_boolean
      ? `<div class="today-badge">TODAY</div>`
      : `<div class="today-badge" style="visibility: hidden;">TODAY</div>`;

    calendar_header_container_element.innerHTML += `
      <div class="day-col-header ${dynamic_today_header_class}">
        ${dynamic_today_badge_html}
        ${WEEK_DAYS_ARRAY[iteration_index]}
        <span>${calculated_date_object.getDate()} ${month_names_array[calculated_date_object.getMonth()].substr(0, 3)}</span>
        <div class="mark-day-container">
          <button class="mark-day-btn mark-p-btn" onclick="mark_full_day_attendance_bulk('${formatted_date_string_value}', 'P')" title="Mark all classes Present">All Present</button>
          <button class="mark-day-btn mark-a-btn" onclick="mark_full_day_attendance_bulk('${formatted_date_string_value}', 'A')" title="Mark all classes Absent">All Absent</button>
        </div>
      </div>
    `;
  }

  calendar_body_container_element.innerHTML = '';
  for (
    let hour_iteration_index = 8;
    hour_iteration_index <= 17;
    hour_iteration_index++
  ) {
    calendar_body_container_element.innerHTML += `<div class="time-slot-label" style="grid-row: ${hour_iteration_index - 7}">${hour_iteration_index}:00</div>`;
    for (
      let day_iteration_index = 1;
      day_iteration_index <= 5;
      day_iteration_index++
    ) {
      const corresponding_date_string =
        current_week_dates_array[day_iteration_index - 1];
      const is_current_day_boolean_cell =
        corresponding_date_string === actual_current_date_string;
      const dynamic_cell_class_name = is_current_day_boolean_cell
        ? 'grid-cell today-cell'
        : 'grid-cell';

      calendar_body_container_element.innerHTML += `<div class="${dynamic_cell_class_name}" style="grid-column: ${day_iteration_index + 1}; grid-row: ${hour_iteration_index - 7}" onclick="handle_empty_cell_click('${WEEK_DAYS_ARRAY[day_iteration_index - 1]}', ${hour_iteration_index})"></div>`;
    }
  }

  const unified_lectures_array_to_render = [];

  application_state.weekly_schedule_slots.forEach(schedule_slot_item => {
    const corresponding_day_index_value = WEEK_DAYS_ARRAY.indexOf(
      schedule_slot_item.day_of_week_name,
    );
    const corresponding_date_string_value =
      current_week_dates_array[corresponding_day_index_value];
    unified_lectures_array_to_render.push({
      lecture_type_string: 'slot',
      lecture_identifier: schedule_slot_item.slot_identifier,
      parent_subject_identifier: schedule_slot_item.parent_subject_identifier,
      lecture_date_string: corresponding_date_string_value,
      lecture_day_index: corresponding_day_index_value,
      lecture_start_hour: schedule_slot_item.start_time_hour_value,
      lecture_duration_hours: schedule_slot_item.lecture_duration_value,
    });
  });

  application_state.additional_extra_classes.forEach(extra_class_item => {
    const parsed_extra_class_date = new Date(
      extra_class_item.lecture_date_string,
    );
    parsed_extra_class_date.setHours(0, 0, 0, 0);
    const calculated_difference_in_days = Math.round(
      (parsed_extra_class_date - application_state.start_of_current_week) /
      (1000 * 60 * 60 * 24),
    );
    if (
      calculated_difference_in_days >= 0 &&
      calculated_difference_in_days <= 4
    ) {
      unified_lectures_array_to_render.push({
        lecture_type_string: 'extra',
        lecture_identifier: extra_class_item.extra_class_identifier,
        parent_subject_identifier: extra_class_item.parent_subject_identifier,
        lecture_date_string: extra_class_item.lecture_date_string,
        lecture_day_index: calculated_difference_in_days,
        lecture_start_hour: extra_class_item.start_time_hour_value,
        lecture_duration_hours: extra_class_item.lecture_duration_value,
      });
    }
  });

  unified_lectures_array_to_render.forEach(lecture_data_object => {
    const parent_subject_data_object = retrieve_subject_object_by_identifier(
      lecture_data_object.parent_subject_identifier,
    );
    if (!parent_subject_data_object) return;

    const generated_attendance_identifier = `att_${lecture_data_object.parent_subject_identifier}_${lecture_data_object.lecture_date_string}_${lecture_data_object.lecture_start_hour}`;
    let retrieved_attendance_record = application_state.attendance_records.find(
      attendance_item =>
        attendance_item.attendance_identifier ===
        generated_attendance_identifier,
    );
    let active_statuses_array = retrieved_attendance_record
      ? retrieved_attendance_record.lecture_status_array
      : new Array(lecture_data_object.lecture_duration_hours).fill(null);

    const primary_status_value = active_statuses_array[0];
    const dynamic_present_class =
      primary_status_value === 'P' ? 'active-p' : '';
    const dynamic_absent_class = primary_status_value === 'A' ? 'active-a' : '';
    const dynamic_cancelled_class =
      primary_status_value === 'C' ? 'active-c' : '';

    let generated_attendance_html_string = `
      <div class="attendance-controls">
        <div class="attendance-row">
          <button class="att-btn ${dynamic_present_class}" onclick="mark_specific_lecture_attendance_bulk('${generated_attendance_identifier}', '${lecture_data_object.parent_subject_identifier}', '${lecture_data_object.lecture_date_string}', ${lecture_data_object.lecture_start_hour}, ${lecture_data_object.lecture_duration_hours}, 'P')">[P]</button>
          <button class="att-btn ${dynamic_absent_class}" onclick="mark_specific_lecture_attendance_bulk('${generated_attendance_identifier}', '${lecture_data_object.parent_subject_identifier}', '${lecture_data_object.lecture_date_string}', ${lecture_data_object.lecture_start_hour}, ${lecture_data_object.lecture_duration_hours}, 'A')">[A]</button>
          <button class="att-btn ${dynamic_cancelled_class}" onclick="mark_specific_lecture_attendance_bulk('${generated_attendance_identifier}', '${lecture_data_object.parent_subject_identifier}', '${lecture_data_object.lecture_date_string}', ${lecture_data_object.lecture_start_hour}, ${lecture_data_object.lecture_duration_hours}, 'C')">[C]</button>
        </div>
      </div>`;

    const constructed_lecture_card_element = document.createElement('div');
    constructed_lecture_card_element.className = 'lecture-card';
    constructed_lecture_card_element.style.gridColumn =
      lecture_data_object.lecture_day_index + 2;
    constructed_lecture_card_element.style.gridRow = `${lecture_data_object.lecture_start_hour - 7} / span ${lecture_data_object.lecture_duration_hours}`;
    constructed_lecture_card_element.style.borderColor =
      parent_subject_data_object.subject_color_hex || 'var(--accent)';

    constructed_lecture_card_element.innerHTML = `
      <div class="lecture-info">
        <strong style="color: ${parent_subject_data_object.subject_color_hex || 'var(--accent)'}">${parent_subject_data_object.subject_code_text}</strong>
        <span>${parent_subject_data_object.subject_name_text}</span>
        <span style="font-size:9px; color:var(--text-muted); margin-top:2px;">
          ${lecture_data_object.lecture_start_hour}:00 - ${lecture_data_object.lecture_start_hour + lecture_data_object.lecture_duration_hours}:00 
          ${lecture_data_object.lecture_type_string === 'extra' ? '(Extra)' : ''}
        </span>
      </div>
      ${generated_attendance_html_string}
      <button class="icon-btn delete-btn" style="position:absolute; top:4px; right:4px;" onclick="delete_scheduled_lecture_instance('${lecture_data_object.lecture_type_string}', '${lecture_data_object.lecture_identifier}')">✖</button>
    `;
    calendar_body_container_element.appendChild(
      constructed_lecture_card_element,
    );
  });
}

window.toggle_desktop_sidebar = function () {
  document.querySelector('.sidebar').classList.toggle('collapsed');
};

window.toggle_mobile_sidebar = function () {
  document.querySelector('.sidebar').classList.toggle('active');
  const overlay = document.getElementById('mobile_sidebar_overlay');
  if (overlay) {
    overlay.classList.toggle('active');
  }
};

window.handleDateChange = function (selectedDateString) {
  if (!selectedDateString) return;

  const [year, month, day] = selectedDateString.split('-').map(Number);
  const selectedDate = new Date(year, month - 1, day);

  const currDate = new Date(application_state.current_mobile_date_object);
  currDate.setHours(0, 0, 0, 0);

  const diffTime = selectedDate - currDate;
  const offset = Math.round(diffTime / 86400000);

  navigate_mobile_day(offset);
};

window.open_desktop_date_picker = function () {
  if (window.innerWidth <= 1000) return;

  const desktop_date_selection_input = document.getElementById(
    'desktop_date_selection',
  );
  if (!desktop_date_selection_input) return;

  desktop_date_selection_input.value = format_date_to_string_format(
    application_state.start_of_current_week || new Date(),
  );

  if (typeof desktop_date_selection_input.showPicker === 'function') {
    desktop_date_selection_input.showPicker();
    return;
  }

  desktop_date_selection_input.click();
};

window.handleDesktopDateChange = function (selectedDateString) {
  if (!selectedDateString || window.innerWidth <= 1000) return;

  const [year, month, day] = selectedDateString.split('-').map(Number);
  const selected_date_object = new Date(year, month - 1, day);
  if (Number.isNaN(selected_date_object.getTime())) return;

  application_state.start_of_current_week =
    calculate_monday_of_target_week(selected_date_object);
  render_entire_application_interface();
};

window.navigate_mobile_day = function (day_offset_integer_value) {
  application_state.current_mobile_date_object.setDate(
    application_state.current_mobile_date_object.getDate() +
    day_offset_integer_value,
  );
  render_entire_application_interface();
};
window.switch_mobile_view = function (mode) {
  application_state.mobile_view_mode = mode;
  render_entire_application_interface();
};
window.navigate_mobile_to_today = function () {
  application_state.current_mobile_date_object = new Date();
  application_state.start_of_current_week = calculate_monday_of_target_week(
    new Date(),
  );
  render_entire_application_interface();
};

function render_mobile_interface() {
  const container = document.querySelector('.calendar-container');
  if (document.getElementById('calendar_header_container')) document.getElementById('calendar_header_container').style.display = 'none';
  if (document.getElementById('calendar_body_container')) document.getElementById('calendar_body_container').style.display = 'none';

  if (!container) return;

  let mobile_container = document.getElementById('mobile_view_container');
  if (!mobile_container) {
    mobile_container = document.createElement('div');
    mobile_container.id = 'mobile_view_container';
    container.appendChild(mobile_container);
  }
  mobile_container.style.display = 'block';

  if (application_state.mobile_view_mode === 'day') {
    render_mobile_day_view(mobile_container);
  } else {
    render_mobile_week_view(mobile_container);
  }
}

function render_mobile_day_view(mobile_container) {
  const target_date_string = format_date_to_string_format(
    application_state.current_mobile_date_object,
  );
  const derived_day_name_string = [
    'Sunday',
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
  ][application_state.current_mobile_date_object.getDay()];
  const month_names_array = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const formatted_display_date = `${derived_day_name_string}, ${application_state.current_mobile_date_object.getDate()} ${month_names_array[application_state.current_mobile_date_object.getMonth()]}`;

  const actual_today_string = format_date_to_string_format(new Date());
  const is_today = target_date_string === actual_today_string;
  const today_indicator_html = is_today
    ? `<span style="color: var(--accent); font-size: 13px; font-weight: 700; margin-left: 6px;">• TODAY</span>`
    : '';

  let html_content_string = `
    <div class="mobile-view-toggle">
      <button class="toggle-btn active" onclick="switch_mobile_view('day')">Day View</button>
      <button class="toggle-btn" onclick="switch_mobile_view('week')">Week View</button>
    </div>
    <div class="mobile-day-nav">
      <button class="nav-btn" onclick="navigate_mobile_day(-1)">◀ Prev</button>
      <div style="display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 0 12px;">
  <label style="display: flex; align-items: center; gap: 4px; cursor: pointer;">
    <h3 style="font-size: 15px; font-weight: 600; color: var(--text); display:flex; align-items:center; margin:0;">
      ${formatted_display_date} ${today_indicator_html}
    </h3>

    <input 
      type="date" 
      onchange="handleDateChange(this.value)"
      value="${target_date_string}"
      onclick="this.showPicker()" 
      style="position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); border: 0;" 
    />
  </label>

  ${!is_today ? `<button class="nav-btn" style="padding: 4px 10px; font-size: 11px;" onclick="navigate_mobile_to_today()">Today</button>` : ''}
</div>
      <button class="nav-btn" onclick="navigate_mobile_day(1)">Next ▶</button>
    </div>
    <div class="mark-day-container" style="padding: 12px 15px; border-bottom: 1px solid var(--border); margin-top: 0;">
      <button class="mark-day-btn mark-p-btn" style="padding: 10px; font-size: 13px; font-weight: 600;" onclick="mark_full_day_attendance_bulk('${target_date_string}', 'P')">Mark Day Present</button>
      <button class="mark-day-btn mark-a-btn" style="padding: 10px; font-size: 13px; font-weight: 600;" onclick="mark_full_day_attendance_bulk('${target_date_string}', 'A')">Mark Day Absent</button>
    </div>
    <div class="mobile-lecture-list">
  `;

  let compiled_lectures_for_day_array = gather_lectures_for_date(
    target_date_string,
    derived_day_name_string,
  );

  if (compiled_lectures_for_day_array.length === 0) {
    html_content_string += `<div style="text-align: center; color: var(--text-muted); padding: 40px 20px;">No classes scheduled for this day.</div>`;
  } else {
    compiled_lectures_for_day_array.forEach(lecture_data_object => {
      const parent_subject_data_object = retrieve_subject_object_by_identifier(
        lecture_data_object.parent_subject_identifier,
      );
      if (!parent_subject_data_object) return;

      const generated_attendance_identifier = `att_${lecture_data_object.parent_subject_identifier}_${target_date_string}_${lecture_data_object.start_time_hour_value}`;
      let retrieved_attendance_record =
        application_state.attendance_records.find(
          attendance_item =>
            attendance_item.attendance_identifier ===
            generated_attendance_identifier,
        );
      let active_statuses_array = retrieved_attendance_record
        ? retrieved_attendance_record.lecture_status_array
        : new Array(lecture_data_object.lecture_duration_value).fill(null);

      const primary_status_value = active_statuses_array[0];
      const dynamic_present_class =
        primary_status_value === 'P' ? 'active-p' : '';
      const dynamic_absent_class =
        primary_status_value === 'A' ? 'active-a' : '';
      const dynamic_cancelled_class =
        primary_status_value === 'C' ? 'active-c' : '';

      html_content_string += `
        <div class="mobile-lecture-card" style="border-left: 4px solid ${parent_subject_data_object.subject_color_hex || 'var(--accent)'}">
          <div style="display: flex; justify-content: space-between; align-items: flex-start;">
            <div class="lecture-info">
              <strong style="color: ${parent_subject_data_object.subject_color_hex || 'var(--accent)'}; font-size: 15px;">${parent_subject_data_object.subject_code_text}</strong>
              <span style="font-size: 14px; margin-top: 2px;">${parent_subject_data_object.subject_name_text}</span>
              <span style="font-size: 12px; color: var(--text-muted); margin-top: 6px;">
                ${lecture_data_object.start_time_hour_value}:00 - ${lecture_data_object.start_time_hour_value + lecture_data_object.lecture_duration_value}:00
                ${lecture_data_object.lecture_type_string === 'extra' ? '<span style="color: var(--accent); margin-left: 4px;">(Extra Class)</span>' : ''}
              </span>
            </div>
            <button class="icon-btn delete-btn" style="font-size: 18px; padding: 4px;" onclick="delete_scheduled_lecture_instance('${lecture_data_object.lecture_type_string}', '${lecture_data_object.lecture_identifier}')">✖</button>
          </div>
          <div class="attendance-controls" style="margin-top: 8px;">
            <div class="attendance-row">
              <button class="att-btn ${dynamic_present_class}" onclick="mark_specific_lecture_attendance_bulk('${generated_attendance_identifier}', '${lecture_data_object.parent_subject_identifier}', '${target_date_string}', ${lecture_data_object.start_time_hour_value}, ${lecture_data_object.lecture_duration_value}, 'P')">Present</button>
              <button class="att-btn ${dynamic_absent_class}" onclick="mark_specific_lecture_attendance_bulk('${generated_attendance_identifier}', '${lecture_data_object.parent_subject_identifier}', '${target_date_string}', ${lecture_data_object.start_time_hour_value}, ${lecture_data_object.lecture_duration_value}, 'A')">Absent</button>
              <button class="att-btn ${dynamic_cancelled_class}" onclick="mark_specific_lecture_attendance_bulk('${generated_attendance_identifier}', '${lecture_data_object.parent_subject_identifier}', '${target_date_string}', ${lecture_data_object.start_time_hour_value}, ${lecture_data_object.lecture_duration_value}, 'C')">Cancelled</button>
            </div>
          </div>
        </div>
      `;
    });
  }
  html_content_string += `</div>`;
  mobile_container.innerHTML = html_content_string;
}

function render_mobile_week_view(mobile_container) {
  const month_names_array = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const week_start_label = `${application_state.start_of_current_week.getDate()} ${month_names_array[application_state.start_of_current_week.getMonth()]}`;
  const actual_today_string = format_date_to_string_format(new Date());

  const current_real_week_start = calculate_monday_of_target_week(new Date());
  const is_current_week =
    format_date_to_string_format(application_state.start_of_current_week) ===
    format_date_to_string_format(current_real_week_start);

  let html_content_string = `
    <div class="mobile-view-toggle">
      <button class="toggle-btn" onclick="switch_mobile_view('day')">Day View</button>
      <button class="toggle-btn active" onclick="switch_mobile_view('week')">Week View</button>
    </div>
    <div class="mobile-day-nav">
      <button class="nav-btn" onclick="navigate_calendar_weeks(-1)">◀ Prev</button>
      <div style="display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 0 12px;">
        <div style="display: flex; align-items: center; gap: 4px;">
          <h3 style="font-size: 14px; font-weight: 600; color: var(--text);">Week of ${week_start_label}</h3>
        </div>
        ${!is_current_week ? `<button class="nav-btn" style="padding: 4px 10px; font-size: 11px;" onclick="navigate_mobile_to_today()">Current Week</button>` : ''}
      </div>
      <button class="nav-btn" onclick="navigate_calendar_weeks(1)">Next ▶</button>
    </div>
    <div style="padding: 0 15px 15px 15px;">
  `;

  for (let day_index = 0; day_index < 5; day_index++) {
    let calculated_day_date = new Date(application_state.start_of_current_week);
    calculated_day_date.setDate(calculated_day_date.getDate() + day_index);
    const loop_date_string = format_date_to_string_format(calculated_day_date);
    const loop_day_name = WEEK_DAYS_ARRAY[day_index];
    const display_date_header = `${loop_day_name}, ${calculated_day_date.getDate()} ${month_names_array[calculated_day_date.getMonth()]}`;

    const is_today = loop_date_string === actual_today_string;
    const today_badge_html = is_today
      ? `<span style="color:var(--bg); background:var(--accent); font-size:9px; padding: 2px 6px; border-radius:12px; margin-left:8px; font-weight:700; vertical-align: middle;">TODAY</span>`
      : '';

    html_content_string += `<h4 style="font-size: 13px; color: var(--text-muted); margin-top: 18px; margin-bottom: 10px; border-bottom: 1px solid var(--border); padding-bottom: 6px;">${display_date_header} ${today_badge_html}</h4>`;

    let compiled_lectures = gather_lectures_for_date(
      loop_date_string,
      loop_day_name,
    );

    if (compiled_lectures.length === 0) {
      html_content_string += `<div style="color: var(--border); font-size: 12px; padding: 4px 0; font-style: italic;">No classes scheduled</div>`;
    } else {
      compiled_lectures.forEach(lecture_data => {
        const parent_subject_data = retrieve_subject_object_by_identifier(
          lecture_data.parent_subject_identifier,
        );
        if (!parent_subject_data) return;

        const att_identifier = `att_${lecture_data.parent_subject_identifier}_${loop_date_string}_${lecture_data.start_time_hour_value}`;
        let att_record = application_state.attendance_records.find(
          a => a.attendance_identifier === att_identifier,
        );
        let statuses = att_record
          ? att_record.lecture_status_array
          : new Array(lecture_data.lecture_duration_value).fill(null);
        let pri_status = statuses[0];

        const p_class = pri_status === 'P' ? 'active-p' : '';
        const a_class = pri_status === 'A' ? 'active-a' : '';
        const c_class = pri_status === 'C' ? 'active-c' : '';

        html_content_string += `
          <div class="compact-lecture-card" style="border-left-color: ${parent_subject_data.subject_color_hex || 'var(--accent)'}">
            <div class="compact-lecture-info">
              <strong style="color: ${parent_subject_data.subject_color_hex || 'var(--accent)'}; font-size: 13px;">${parent_subject_data.subject_code_text}</strong>
              <span style="font-size: 11px; color: var(--text-muted); margin-top: 3px;"> ${lecture_data.start_time_hour_value}:00 - ${lecture_data.start_time_hour_value + lecture_data.lecture_duration_value}:00</span>
            </div>
            <div class="compact-att-controls">
              <button class="compact-att-btn ${p_class}" style="${p_class ? 'background:var(--present); color:#000; border-color:var(--present);' : ''}" onclick="mark_specific_lecture_attendance_bulk('${att_identifier}', '${lecture_data.parent_subject_identifier}', '${loop_date_string}', ${lecture_data.start_time_hour_value}, ${lecture_data.lecture_duration_value}, 'P')">P</button>
              <button class="compact-att-btn ${a_class}" style="${a_class ? 'background:var(--absent); color:#fff; border-color:var(--absent);' : ''}" onclick="mark_specific_lecture_attendance_bulk('${att_identifier}', '${lecture_data.parent_subject_identifier}', '${loop_date_string}', ${lecture_data.start_time_hour_value}, ${lecture_data.lecture_duration_value}, 'A')">A</button>
              <button class="compact-att-btn ${c_class}" style="${c_class ? 'background:var(--cancelled); color:#fff; border-color:var(--cancelled);' : ''}" onclick="mark_specific_lecture_attendance_bulk('${att_identifier}', '${lecture_data.parent_subject_identifier}', '${loop_date_string}', ${lecture_data.start_time_hour_value}, ${lecture_data.lecture_duration_value}, 'C')">C</button>
            </div>
          </div>
        `;
      });
    }
  }
  html_content_string += `</div>`;
  mobile_container.innerHTML = html_content_string;
}

function scroll_interface_to_current_time_slot() {
  const scrolling_container_element = document.querySelector(
    '.calendar-container',
  );
  if (!scrolling_container_element) return;
  const current_system_hour_value = new Date().getHours();

  if (current_system_hour_value >= 8 && current_system_hour_value <= 17) {
    const calculated_target_scroll_position =
      (current_system_hour_value - 8) * 80 - 30;
    scrolling_container_element.scrollTo({
      top: Math.max(0, calculated_target_scroll_position),
      behavior: 'smooth',
    });
  }
}

function update_dropdown_selection_options() {
  const slot_subject_dropdown_element = document.getElementById(
    'slot_subject_selection',
  );
  const extra_subject_dropdown_element = document.getElementById(
    'extra_subject_selection',
  );
  const assignment_subject_selection = document.getElementById(
    'assignment_subject_selection',
  );

  const generated_options_html_string = application_state.enrolled_subjects
    .map(
      subject_item =>
        `<option value="${subject_item.subject_identifier}">${subject_item.subject_name_text} (${subject_item.subject_code_text})</option>`,
    )
    .join('');

  if (slot_subject_dropdown_element) slot_subject_dropdown_element.innerHTML = generated_options_html_string;
  if (extra_subject_dropdown_element) extra_subject_dropdown_element.innerHTML = generated_options_html_string;
  if (assignment_subject_selection) assignment_subject_selection.innerHTML = generated_options_html_string;
}

function initialize_color_selection_palette(
  selected_color_hex_value = THEME_COLORS_ARRAY[0],
) {
  const color_picker_container_element = document.getElementById(
    'color_selection_container',
  );
  const subject_color_hidden_input_element = document.getElementById(
    'subject_color_input',
  );
  if (!color_picker_container_element) return;
  color_picker_container_element.innerHTML = THEME_COLORS_ARRAY.map(
    color_hex_code =>
      `<div class="color-swatch ${color_hex_code === selected_color_hex_value ? 'selected' : ''}" style="background:${color_hex_code}" onclick="select_subject_color_swatch(this, '${color_hex_code}')"></div>`,
  ).join('');
  subject_color_hidden_input_element.value = selected_color_hex_value;
}

window.select_subject_color_swatch = function (
  clicked_element,
  color_hex_code_value,
  ) {
  document
    .querySelectorAll('.color-swatch')
    .forEach(swatch_element => swatch_element.classList.remove('selected'));
  clicked_element.classList.add('selected');
  document.getElementById('subject_color_input').value = color_hex_code_value;
};

let pending_custom_confirm_callback = null;

window.show_custom_alert = function (message) {
  const alert_message_element = document.getElementById('custom_alert_message');
  alert_message_element.textContent = message;
  open_interface_modal('custom_alert_modal');
  setTimeout(() => document.getElementById('custom_alert_ok_button').focus(), 0);
};

window.close_custom_alert = function () {
  document.getElementById('custom_alert_modal').classList.remove('active');
};

window.show_custom_confirm = function (message, onConfirm) {
  pending_custom_confirm_callback =
    typeof onConfirm === 'function' ? onConfirm : null;
  const confirm_message_element = document.getElementById(
    'custom_confirm_message',
  );
  confirm_message_element.textContent = message;
  open_interface_modal('custom_confirm_modal');
  setTimeout(
    () => document.getElementById('custom_confirm_cancel_button').focus(),
    0,
  );
};

window.cancel_custom_confirm = function () {
  pending_custom_confirm_callback = null;
  document.getElementById('custom_confirm_modal').classList.remove('active');
};

window.confirm_custom_dialog = function () {
  const callback_to_execute = pending_custom_confirm_callback;
  pending_custom_confirm_callback = null;
  document.getElementById('custom_confirm_modal').classList.remove('active');
  if (callback_to_execute) callback_to_execute();
};

window.handle_empty_cell_click = function (day_name, hour_value) {
  if (application_state.enrolled_subjects.length === 0) {
    show_custom_alert('Please add a subject first!');
    return;
  }
  document.getElementById('slot_day_selection').value = day_name;
  document.getElementById('slot_start_time_selection').value = hour_value;
  document.getElementById('slot_duration_selection').value = '1';
  open_interface_modal('weekly_slot_modal');
};

window.open_add_subject_modal = function () {
  currently_editing_subject_identifier = null;
  document.getElementById('subject_modal_title_text').innerText = 'Add Subject';
  document.getElementById('subject_input_form').reset();

  const target_input = document.getElementById('subject_target_input');
  if (target_input) target_input.value = 75;

  initialize_color_selection_palette(THEME_COLORS_ARRAY[0]);
  open_interface_modal('subject_creation_modal');
};

window.open_edit_subject_modal = function (target_subject_identifier) {
  currently_editing_subject_identifier = target_subject_identifier;
  const retrieved_subject_data = retrieve_subject_object_by_identifier(
    target_subject_identifier,
  );
  document.getElementById('subject_modal_title_text').innerText =
    'Edit Subject';
  document.getElementById('subject_name_input').value =
    retrieved_subject_data.subject_name_text;
  document.getElementById('subject_code_input').value =
    retrieved_subject_data.subject_code_text;

  const target_input = document.getElementById('subject_target_input');
  if (target_input)
    target_input.value = retrieved_subject_data.target_percentage || 75;

  initialize_color_selection_palette(
    retrieved_subject_data.subject_color_hex || THEME_COLORS_ARRAY[0],
  );
  open_interface_modal('subject_creation_modal');
};

document
  .getElementById('subject_input_form')
  .addEventListener('submit', form_submit_event => {
    form_submit_event.preventDefault();
    const entered_subject_name_value = document
      .getElementById('subject_name_input')
      .value.trim();
    const entered_subject_code_value = document
      .getElementById('subject_code_input')
      .value.trim();
    const selected_subject_color_value = document.getElementById(
      'subject_color_input',
    ).value;

    const entered_target_percentage =
      parseInt(document.getElementById('subject_target_input').value) || 75;

    if (currently_editing_subject_identifier) {
      if (
        application_state.enrolled_subjects.find(
          subject_item =>
            subject_item.subject_code_text === entered_subject_code_value &&
            subject_item.subject_identifier !==
            currently_editing_subject_identifier,
        )
      ) {
        show_custom_alert('Subject code must be unique!');
        return;
      }
      const subject_to_update = retrieve_subject_object_by_identifier(
        currently_editing_subject_identifier,
      );
      persist_collection_record('subjects', currently_editing_subject_identifier, {
        ...subject_to_update,
        subject_name_text: entered_subject_name_value,
        subject_code_text: entered_subject_code_value,
        subject_color_hex: selected_subject_color_value,
        target_percentage: entered_target_percentage
      }, { merge: true });
    } else {
      if (
        application_state.enrolled_subjects.find(
          subject_item =>
            subject_item.subject_code_text === entered_subject_code_value,
        )
      ) {
        show_custom_alert('Subject code must be unique!');
        return;
      }
      const new_id = generate_unique_random_identifier('sub');
      persist_collection_record('subjects', new_id, {
        subject_identifier: new_id,
        subject_name_text: entered_subject_name_value,
        subject_code_text: entered_subject_code_value,
        subject_color_hex: selected_subject_color_value,
        target_percentage: entered_target_percentage,
      });
    }
    close_all_interface_modals();
  });

window.delete_selected_subject_data = function (target_subject_identifier) {
  show_custom_confirm(
    'Delete subject? This will remove all associated slots, extra classes, assignments, and attendance.',
    () => {
      delete_collection_record('subjects', target_subject_identifier);

      application_state.weekly_schedule_slots.filter(
        slot_item => slot_item.parent_subject_identifier === target_subject_identifier
      ).forEach(slot_item => {
        delete_collection_record('weekly_slots', slot_item.slot_identifier);
      });
      application_state.additional_extra_classes.filter(
        extra_class_item => extra_class_item.parent_subject_identifier === target_subject_identifier
      ).forEach(extra_class_item => {
        delete_collection_record('extra_classes', extra_class_item.extra_class_identifier);
      });
      application_state.attendance_records.filter(
        attendance_item => attendance_item.parent_subject_identifier === target_subject_identifier
      ).forEach(attendance_item => {
        delete_collection_record('attendance_records', attendance_item.attendance_identifier);
      });
      application_state.assignments.filter(
        assignment_item => assignment_item.parent_subject_identifier === target_subject_identifier
      ).forEach(assignment_item => {
        delete_collection_record('assignments', assignment_item.assignment_identifier);
      });
    },
  );
};

document
  .getElementById('weekly_slot_form')
  .addEventListener('submit', form_submit_event => {
    form_submit_event.preventDefault();
    const new_id = generate_unique_random_identifier('slot');
    persist_collection_record('weekly_slots', new_id, {
      slot_identifier: new_id,
      parent_subject_identifier: document.getElementById('slot_subject_selection').value,
      day_of_week_name: document.getElementById('slot_day_selection').value,
      start_time_hour_value: parseInt(document.getElementById('slot_start_time_selection').value),
      lecture_duration_value: parseInt(document.getElementById('slot_duration_selection').value),
    });
    close_all_interface_modals();
  });

document
  .getElementById('extra_class_input_form')
  .addEventListener('submit', form_submit_event => {
    form_submit_event.preventDefault();
    const new_id = generate_unique_random_identifier('extra');
    persist_collection_record('extra_classes', new_id, {
      extra_class_identifier: new_id,
      parent_subject_identifier: document.getElementById('extra_subject_selection').value,
      lecture_date_string: document.getElementById('extra_date_selection').value,
      start_time_hour_value: parseInt(document.getElementById('extra_start_time_selection').value),
      lecture_duration_value: parseInt(document.getElementById('extra_duration_selection').value),
    });
    close_all_interface_modals();
  });

window.delete_scheduled_lecture_instance = function (
  lecture_type_string_value,
  target_lecture_identifier,
) {
  show_custom_confirm(
    'Delete this class? All associated attendance records will be removed.',
    () => {
      if (lecture_type_string_value === 'slot') {
        const located_slot_record = application_state.weekly_schedule_slots.find(
          slot_item => slot_item.slot_identifier === target_lecture_identifier,
        );
        if (located_slot_record) {
          application_state.attendance_records.forEach(attendance_item => {
            if (
              attendance_item.parent_subject_identifier ===
              located_slot_record.parent_subject_identifier &&
              attendance_item.lecture_start_hour ===
              located_slot_record.start_time_hour_value
            ) {
              const parsed_attendance_date = new Date(
                attendance_item.lecture_date_string + 'T00:00:00',
              );
              const derived_day_name_string = [
                'Sunday',
                'Monday',
                'Tuesday',
                'Wednesday',
                'Thursday',
                'Friday',
                'Saturday',
              ][parsed_attendance_date.getDay()];
              if (
                derived_day_name_string ===
                located_slot_record.day_of_week_name
              ) {
                delete_collection_record('attendance_records', attendance_item.attendance_identifier);
              }
            }
          });
        }
        delete_collection_record('weekly_slots', target_lecture_identifier);
      }

      if (lecture_type_string_value === 'extra') {
        const located_extra_class_record =
          application_state.additional_extra_classes.find(
            extra_class_item =>
              extra_class_item.extra_class_identifier ===
              target_lecture_identifier,
          );
        if (located_extra_class_record) {
          application_state.attendance_records.forEach(attendance_item => {
            if (
              attendance_item.parent_subject_identifier ===
              located_extra_class_record.parent_subject_identifier &&
              attendance_item.lecture_date_string ===
              located_extra_class_record.lecture_date_string &&
              attendance_item.lecture_start_hour ===
              located_extra_class_record.start_time_hour_value
            ) {
              delete_collection_record('attendance_records', attendance_item.attendance_identifier);
            }
          });
        }
        delete_collection_record('extra_classes', target_lecture_identifier);
      }
    },
  );
};

window.mark_specific_lecture_attendance_bulk = function (
  target_attendance_identifier,
  target_subject_identifier,
  target_date_string,
  target_start_hour,
  target_total_hours_duration,
  applied_status_value,
) {
  let located_attendance_record = application_state.attendance_records.find(
    attendance_item =>
      attendance_item.attendance_identifier === target_attendance_identifier,
  );

  let new_status_array = new Array(target_total_hours_duration).fill(null);

  if (!located_attendance_record) {
    new_status_array.fill(applied_status_value);
    persist_collection_record('attendance_records', target_attendance_identifier, {
      attendance_identifier: target_attendance_identifier,
      parent_subject_identifier: target_subject_identifier,
      lecture_date_string: target_date_string,
      lecture_start_hour: target_start_hour,
      lecture_status_array: new_status_array,
    });
  } else {
    if (located_attendance_record.lecture_status_array[0] === applied_status_value) {
      new_status_array.fill(null);
    } else {
      new_status_array.fill(applied_status_value);
    }
    persist_collection_record('attendance_records', target_attendance_identifier, {
      ...located_attendance_record,
      lecture_status_array: new_status_array
    }, { merge: true });
  }
};

window.mark_full_day_attendance_bulk = function (
  target_date_string,
  applied_status_value,
) {
  const parsed_target_date_object = new Date(target_date_string + 'T00:00:00');
  const derived_day_name_string = [
    'Sunday',
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
  ][parsed_target_date_object.getDay()];

  let compiled_lectures_for_day_array = gather_lectures_for_date(
    target_date_string,
    derived_day_name_string,
  );

  if (compiled_lectures_for_day_array.length === 0) {
    show_custom_alert('No classes scheduled for this day.');
    return;
  }

  compiled_lectures_for_day_array.forEach(lecture_data_object => {
    const generated_attendance_identifier = `att_${lecture_data_object.parent_subject_identifier}_${target_date_string}_${lecture_data_object.start_time_hour_value}`;
    let located_attendance_record = application_state.attendance_records.find(
      attendance_item =>
        attendance_item.attendance_identifier ===
        generated_attendance_identifier,
    );

    if (!located_attendance_record) {
      persist_collection_record('attendance_records', generated_attendance_identifier, {
        attendance_identifier: generated_attendance_identifier,
        parent_subject_identifier: lecture_data_object.parent_subject_identifier,
        lecture_date_string: target_date_string,
        lecture_start_hour: lecture_data_object.start_time_hour_value,
        lecture_status_array: new Array(lecture_data_object.lecture_duration_value).fill(applied_status_value),
      });
    } else {
      persist_collection_record('attendance_records', generated_attendance_identifier, {
        ...located_attendance_record,
        lecture_status_array: new Array(lecture_data_object.lecture_duration_value).fill(applied_status_value)
      }, { merge: true });
    }
  });
};

window.navigate_calendar_weeks = function (week_offset_integer_value) {
  application_state.start_of_current_week.setDate(
    application_state.start_of_current_week.getDate() +
    week_offset_integer_value * 7,
  );
  render_entire_application_interface();
};

window.navigate_to_current_week = function () {
  application_state.start_of_current_week = calculate_monday_of_target_week(
    new Date(),
  );
  render_entire_application_interface();
  setTimeout(scroll_interface_to_current_time_slot, 100);
};

window.open_settings_modal = function() {
  document.getElementById('setting_default_module').value = application_state.user_preferences.default_module || 'attendance';
  document.getElementById('setting_mobile_sidebar').value = application_state.user_preferences.open_sidebar_on_startup !== false ? 'true' : 'false';
  open_interface_modal('settings_modal');
};

document.getElementById('settings_form').addEventListener('submit', form_submit_event => {
  form_submit_event.preventDefault();
  const selected_module = document.getElementById('setting_default_module').value;
  const open_sidebar = document.getElementById('setting_mobile_sidebar').value === 'true';
  application_state.user_preferences.default_module = selected_module;
  application_state.user_preferences.open_sidebar_on_startup = open_sidebar;
  persist_user_preferences();
  close_all_interface_modals();
});

window.open_interface_modal = function (target_modal_identifier_string) {
  document
    .getElementById(target_modal_identifier_string)
    .classList.add('active');
};
window.close_all_interface_modals = function () {
  pending_custom_confirm_callback = null;
  currently_editing_assignment_identifier = null;
  document
    .querySelectorAll('.modal-overlay')
    .forEach(modal_overlay_element =>
      modal_overlay_element.classList.remove('active'),
    );
};

['custom_alert_modal', 'custom_confirm_modal'].forEach(modal_identifier => {
  document
    .getElementById(modal_identifier)
    ?.addEventListener('click', click_event => {
      if (click_event.target !== click_event.currentTarget) return;

      if (modal_identifier === 'custom_alert_modal') {
        close_custom_alert();
      } else {
        cancel_custom_confirm();
      }
    });
});

document.addEventListener('keydown', keydown_event => {
  if (keydown_event.key !== 'Escape') return;

  if (
    document.getElementById('custom_alert_modal')?.classList.contains('active')
  ) {
    close_custom_alert();
  }

  if (
    document.getElementById('custom_confirm_modal')?.classList.contains('active')
  ) {
    cancel_custom_confirm();
  }
});

onAuthStateChanged(auth_service_instance, async user => {
  if (!is_initial_auth_resolved) {
    is_initial_auth_resolved = true;
    clearTimeout(auth_timeout_id);
  }

  const login_screen = document.getElementById('login_screen');
  const main_app = document.getElementById('main_app');
  const loading_overlay = document.getElementById('auth_loading_overlay');

  if (user) {
    const guest_data = read_guest_storage_snapshot();
    if (guest_storage_has_data(guest_data)) {
      show_guest_upgrade_modal(user, guest_data);
      if (loading_overlay) {
        loading_overlay.classList.remove('active');
      }
      return;
    }

    await start_authenticated_session(user);
  } else {
    current_logged_in_user = null;
    is_guest_user = false;

    if (localStorage.getItem(GUEST_SESSION_KEY) === 'true') {
      start_guest_session();
    } else {
      login_screen.classList.remove('hidden');
      main_app.classList.add('hidden');

      reset_application_state_to_default();
      update_sidebar_auth_action();
    }
  }

  if (loading_overlay) {
    loading_overlay.classList.remove('active');
  }
});

window.save_guest_data_to_google_account = async function () {
  if (!pending_guest_upgrade_user || !pending_guest_upgrade_data) return;

  const loading_overlay = document.getElementById('auth_loading_overlay');
  const loading_text = document.getElementById('auth_loading_text');

  loading_text.innerText = 'Saving local data...';
  loading_overlay.classList.add('active');

  try {
    await save_guest_snapshot_to_firestore(pending_guest_upgrade_user, pending_guest_upgrade_data);
    clear_guest_local_data();
    document.getElementById('guest_upgrade_modal')?.classList.remove('active');
    const user_to_continue = pending_guest_upgrade_user;
    pending_guest_upgrade_user = null;
    pending_guest_upgrade_data = null;
    await start_authenticated_session(user_to_continue);
  } catch (error) {
    show_custom_alert('Unable to save local data to your Google account. Your guest data is still on this device.');
  } finally {
    loading_overlay.classList.remove('active');
  }
};

window.discard_guest_data_after_google_sign_in = async function () {
  if (!pending_guest_upgrade_user) return;

  const loading_overlay = document.getElementById('auth_loading_overlay');
  const loading_text = document.getElementById('auth_loading_text');
  loading_text.innerText = 'Loading your account...';
  loading_overlay.classList.add('active');

  const user_to_continue = pending_guest_upgrade_user;
  pending_guest_upgrade_user = null;
  pending_guest_upgrade_data = null;
  clear_guest_local_data();
  document.getElementById('guest_upgrade_modal')?.classList.remove('active');
  await start_authenticated_session(user_to_continue);
  loading_overlay.classList.remove('active');
};

window.close_install_help = function () {
  document.getElementById('install_help_modal').classList.remove('active');
};

document.getElementById('install_help_btn')?.addEventListener('click', () => {
  document.getElementById('install_help_modal').classList.add('active');
});

window.addEventListener('resize', () => {
  update_guest_button_visibility();
  render_entire_application_interface();
});

window.matchMedia('(display-mode: standalone)').addEventListener?.('change', update_guest_button_visibility);
window.matchMedia('(display-mode: fullscreen)').addEventListener?.('change', update_guest_button_visibility);
update_guest_button_visibility();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js');
  });
}
